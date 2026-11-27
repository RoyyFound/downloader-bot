// wa-bot.js — WhatsApp (Baileys) downloader, SATU proses dengan bot Telegram.
// Pesan WA berisi link video -> download pakai rantai yang sama (routes.js)
// -> kirim balik MP4/MP3 via WA. Perintah WA: kirim link langsung + /start.
// Login: PAIRING CODE saja (tanpa QR). Nomor dari env WA_NUMBER (tanpa '+').
// Sesi di folder wa-auth/ (gitignore) — INI yang dites di Altare: apakah
// Altare menyimpan file sesi antar deploy.
//
// PELAJARAN BAILEYS (bug 2026-11-04, lihat confess-test/bot-test.js):
//   requestPairingCode() MENYETEL creds.me = nomor HP. Kalau dipanggil
//   sebelum handshake selesai, socket masuk mode LOGIN -> 401 flap loop.
//   Perbaikan: (1) creds.me = undefined sebelum bikin socket selama
//   belum registered (dan sebelum tiap reconnect selama unlinked);
//   (2) minta pairing code HANYA SETELAH event QR (pair-device) membuktikan
//   mode REGISTRATION (log QR_READY); (3) jangan auto-minta kode baru tiap
//   reconnect — kode baru hanya saat startup (sekali per run) atau /pairwa.
//   Setelah pair-success server menutup socket dengan 515 (restart
//   required) — itu TANDA BERHASIL, bukan error; reconnect membawa creds
//   registered yang utuh (me JANGAN dikosongkan).
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, fetchLatestWaWebVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const { videoChain, audioChain, spotifyChain, classifyError } = require('./routes');
const { validateMediaUrl, downloadUrlFile, MAX_BYTES } = require('./downloader');

const AUTH_DIR = path.join(__dirname, 'wa-auth');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let waLogger;
try { waLogger = require('pino')({ level: 'error' }); } catch (_) { waLogger = undefined; }

// Nomor dari env, normalisasi ke digit saja (tanpa '+', tanpa spasi).
// '0...' di depan -> '62...'. Kosong = WA tidak aktif (Telegram tetap jalan).
function normalizeNumber(raw) {
  const d = String(raw || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.startsWith('0')) return '62' + d.slice(1);
  return d;
}
const WA_NUMBER = normalizeNumber(process.env.WA_NUMBER || '');

const WA_START = 'Halo! \u{1F44B} Bot Downloader WA — GRATIS\n\n'
  + 'Kirim link video TikTok / YouTube / Instagram, nanti kekirim balik sebagai video (MP4).\n'
  + '\u2022 Mau audio saja (MP3)? Tulis "mp3" bareng link-nya.\n'
  + '\u2022 Link Spotify langsung jadi MP3.\n\n'
  + 'Maksimal \u00B145MB per file.';

let tgBot = null;
let ownerId = 0;
let authState = null;
let saveCredsFn = null;
let sock = null;
let version = undefined;
let linked = false;
let qrSeen = false;
let sockDead = false;
let reconnectTimer = null;
let startupCodeDone = false;
let codeInFlight = false;
let latestQr = null;
let qrSending = false;

// Anti-spam WA: 1 download per pengirim + maks 5 barengan (sama seperti Telegram).
const busyWa = new Set();
let activeWa = 0;
const MAX_CONCURRENT_WA = 5;

function getWAStatus() {
  return {
    numberSet: !!WA_NUMBER,
    started: !!sock,
    registered: !!(authState && authState.creds.registered),
    connected: !!(sock && sock.user),
  };
}

// Un-poison: HANYA bila perangkat BELUM registered, creds.me HARUS kosong
// supaya handshake masuk mode REGISTRATION, bukan LOGIN.
function unpoison() {
  if (authState && !authState.creds.registered && authState.creds.me) {
    authState.creds.me = undefined;
    console.log('WA_UNPOISONED: creds.me dikosongkan (mode REGISTRATION)');
  }
}

function createSocket() {
  unpoison();
  const s = makeWASocket({
    auth: authState,
    version,
    printQRInTerminal: false,
    logger: waLogger,
    browser: ['Downloader Bot', 'Chrome', '120.0'],
    keepAliveIntervalMs: 20000,
    qrTimeout: 120000,
  });
  s.ev.on('creds.update', saveCredsFn);
  s.ev.on('messages.upsert', onMessagesUpsert);
  s.ev.on('connection.update', (u) => onConnectionUpdate(s, u));
  return s;
}

async function onConnectionUpdate(s, u) {
  if (u.qr && !qrSeen) {
    qrSeen = true;
    latestQr = u.qr;
    console.log('WA_QR_READY: server mengirim pair-device (mode REGISTRATION ok)');
    sendQrToOwner(u.qr);
  }
  if (u.isNewLogin) {
    linked = true;
    console.log('WA_PAIR_SUCCESS: pairing diterima server, koneksi akan restart (515)');
  }
  if (u.connection) console.log('WA_CONNECTION: ' + u.connection);
  if (u.connection === 'open') {
    linked = true;
    console.log('WA_OPEN: ' + (s.user ? s.user.id : '(no user id)'));
  }
  if (u.connection === 'close') {
    sockDead = true;
    const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output
      ? u.lastDisconnect.error.output.statusCode : '?';
    console.log('WA_CLOSED: statusCode=' + code);
    if (code === DisconnectReason.loggedOut || code === 401) {
      // JANGAN process.exit — bot Telegram harus tetap jalan.
      console.log('WA_LOGGED_OUT: sesi WA habis, perlu pairing ulang via /pairwa (Telegram). Telegram tetap jalan.');
      sock = null;
      return;
    }
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        console.log('WA_RECONNECTING');
        sockDead = false;
        qrSeen = false;
        sock = createSocket();
      }, 3000);
    }
  }
}

// Minta pairing code — HANYA setelah mode REGISTRATION terbukti (QR_READY).
// Dipakai startup (sekali per run) dan /pairwa (manual). TIDAK pernah
// dipanggil otomatis saat reconnect.
async function requestPairingCodeOnce() {
  // Mode QR aktif — pairing code dimatikan (fungsi ini tidak pernah dipanggil lagi).
  return { ok: false, error: 'mode QR aktif' };
  if (codeInFlight) return { ok: false, error: 'masih diproses' };
  if (!WA_NUMBER) return { ok: false, error: 'WA_NUMBER tidak diset' };
  if (authState && authState.creds.registered) return { ok: false, error: 'sudah terhubung' };
  codeInFlight = true;
  try {
    for (let waited = 0; waited < 60; waited++) {
      if (authState && authState.creds.registered) return { ok: false, error: 'sudah terhubung' };
      if (qrSeen && sock && !sockDead) break;
      await sleep(500);
    }
    if (!qrSeen) console.log('WA_QR_WAIT_TIMEOUT: lanjut minta kode (socket mungkin sudah siap)');
    let code = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 10 && !code; attempt++) {
      if (!sock || sockDead) {
        await sleep(4000);
        if (!sock || sockDead) continue;
      }
      try {
        throw new Error('mode QR aktif');
      } catch (e) {
        lastErr = e;
        console.log('WA_PAIRING_TRY ' + attempt + ' FAIL: ' + (e && e.message ? e.message : e));
        await sleep(3000);
      }
    }
    if (!code) return { ok: false, error: (lastErr && lastErr.message) || 'gagal minta kode' };
    console.log('WA_PAIRING_CODE: ' + code);
    return { ok: true, code };
  } finally {
    codeInFlight = false;
  }
}

async function sendQrToOwner(qrStr) {
  if (!tgBot || !ownerId) { console.log('WA_QR (tidak ada Telegram owner): QR tidak terkirim'); return; }
  if (qrSending) return;
  qrSending = true;
  try {
    const buf = await QRCode.toBuffer(qrStr, { type: 'png', width: 512, margin: 1 });
    const caption = 'QR WhatsApp (bot downloader) — scan di WA nomor ' + WA_NUMBER + ' \u2192 Pengaturan \u2192 Perangkat Tertaut \u2192 Tautkan Perangkat.\nQR cepat kedaluwarsa — pakai QR terbaru (tiap siklus QR baru). Kalau kedaluwarsa, kirim /pairwa di sini.';
    await tgBot.sendPhoto(ownerId, buf, { caption: caption });
    console.log('WA_QR_SENT_TO_OWNER');
  } catch (e) {
    console.log('WA_QR_SEND_FAIL: ' + e.message);
  } finally {
    qrSending = false;
  }
}

async function sendCodeToOwner(code) {
  if (!tgBot || !ownerId) { console.log('WA_PAIRING_CODE (tidak ada Telegram owner): ' + code); return; }
  const txt = '\u{1F510} Kode pairing WhatsApp (bot downloader): ' + code
    + '\n\nMasukkan di WA nomor ' + WA_NUMBER + ' \u2192 Pengaturan \u2192 Perangkat Tertaut \u2192 Tautkan Perangkat \u2192 "Tautkan dengan nomor telepon".'
    + '\nKode cepat kedaluwarsa — langsung dimasukkan ya. Kalau kedaluwarsa, kirim /pairwa di sini.';
  try { await tgBot.sendMessage(ownerId, txt); console.log('WA_PAIRING_CODE_SENT_TO_OWNER'); }
  catch (e) { console.log('WA_PAIRING_CODE_SEND_FAIL: ' + e.message + ' \u2014 kode: ' + code); }
}

async function initAuth() {
  if (authState) return;
  try {
    try {
      version = (await fetchLatestWaWebVersion()).version;
    } catch (_) {
      version = (await fetchLatestBaileysVersion()).version;
    }
    console.log('WA_VERSION: ' + version.join('.'));
  } catch (e) {
    console.log('WA_VERSION_FETCH_FAIL: pakai versi bawaan lib (' + e.message + ')');
  }
  if (process.env.WA_WIPE_AUTH === '1') {
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); console.log('WA_AUTH_WIPED'); } catch (_) {}
  }
  const r = await useMultiFileAuthState(AUTH_DIR);
  authState = r.state;
  saveCredsFn = r.saveCreds;
  linked = !!authState.creds.registered;
  if (linked) console.log('WA_ALREADY_REGISTERED: sesi wa-auth/ sudah terhubung');
}

async function startWA(opts) {
  tgBot = (opts && opts.tgBot) || null;
  ownerId = (opts && opts.owner) || 0;
  if (!WA_NUMBER) {
    console.log('WA_SKIP: WA_NUMBER tidak diset \u2014 bot WA tidak aktif (Telegram tetap jalan)');
    return { ok: false, reason: 'no-number' };
  }
  await initAuth();
  sock = createSocket();
  if (!linked) console.log('WA_QR_MODE: pairing via QR — QR dikirim ke owner tiap siklus baru');
  return { ok: true, registered: linked };
}

// /pairwa (Telegram, owner saja): kirim ulang QR terbaru (mode QR — pairing code dimatikan).
async function requestPairingCodeNow() {
  if (!WA_NUMBER) return { ok: false, error: 'WA_NUMBER tidak diset di env Altare' };
  if (authState && authState.creds.registered) return { ok: false, error: 'WA sudah terhubung' };
  if (!sock || sockDead) return { ok: false, error: 'socket WA lagi reconnect — tunggu sebentar lalu /pairwa lagi' };
  if (!latestQr) return { ok: false, error: 'belum ada QR — tunggu sebentar lalu /pairwa lagi' };
  await sendQrToOwner(latestQr);
  return { ok: true, qr: true };
}

function waKey(jid) { return 'wa_' + String(jid).replace(/[^0-9a-z]/gi, '_'); }

function waFailText(err) {
  const failures = (err && err.failures) || [];
  const cls = (err && err.cls) || classifyError(err);
  if (failures.some((f) => f.cls === 'LIMIT')) return '\u274C API TikTok lagi kena limit harian. Coba lagi besok pagi, atau coba link YouTube/Instagram.';
  if (cls === 'BOTCHECK' || failures.some((f) => f.cls === 'BOTCHECK')) return '\u274C YouTube lagi nge-blokir download dari server bot. Coba lagi beberapa menit lagi.';
  if (failures.some((f) => f.cls === 'DOWN')) return '\u274C Server API TikTok lagi down/error. Coba lagi nanti.';
  if (cls === 'NOTFOUND' || failures.some((f) => f.cls === 'NOTFOUND')) return '\u274C Videonya nggak ketemu / privat / login-only. Pastikan link-nya publik.';
  if (cls === 'NETWORK' || failures.some((f) => f.cls === 'NETWORK')) return '\u274C Koneksi ke server video lagi bermasalah. Coba lagi bentar.';
  return '\u274C Gagal ambil video. Coba link lain, atau pastikan videonya publik.';
}

async function handleWADownload(jid, url, fmt) {
  const t0 = Date.now();
  const v = validateMediaUrl(url);
  if (!v.ok) return sock.sendMessage(jid, { text: '\u274C Link nggak bisa diproses (' + v.reason + '). Kirim link TikTok / YouTube / Instagram yang publik ya.' });
  url = v.url;
  const plat = v.platform || 'youtube';
  const key = waKey(jid);
  if (busyWa.has(key)) return sock.sendMessage(jid, { text: '\u23F3 Masih ada download kamu yang jalan, tunggu selesai dulu ya.' });
  if (activeWa >= MAX_CONCURRENT_WA) return sock.sendMessage(jid, { text: '\u23F3 Bot lagi sibuk, coba lagi bentar ya.' });
  busyWa.add(key);
  activeWa++;
  const proc = await sock.sendMessage(jid, { text: '\u23F3 Lagi diproses (' + fmt.toUpperCase() + '), bentar ya\u2026' }).catch(() => null);
  const clearProc = async () => { if (proc && proc.key) { try { await sock.sendMessage(jid, { delete: proc.key }); } catch (_) {} } };
  const tmpFiles = [];
  try {
    if (plat === 'spotify') {
      let lastErr = null;
      for await (const res of spotifyChain(url, key)) {
        try {
          if (res.size > MAX_BYTES) { await clearProc(); await sock.sendMessage(jid, { text: '\u274C Audionya kegedean (di atas \u00B145MB). Coba lagu lain.' }); return; }
          tmpFiles.push(res.file);
          await sock.sendMessage(jid, { audio: { url: res.file }, mimetype: 'audio/mpeg' });
          await clearProc();
          console.log('WA_SPOTIFY_OK jid=' + jid + ' ms=' + (Date.now() - t0));
          return;
        } catch (e) { lastErr = e; console.log('WA_SPOTIFY_SEND_FAIL route=' + res.route + ' err=' + e.message); }
      }
      throw lastErr || new Error('CHAIN_FAIL');
    }
    const gen = fmt === 'mp4' ? videoChain(plat, url, key) : audioChain(plat, url, key);
    let lastErr = null;
    for await (const res of gen) {
      try {
        let file = null;
        if (res.mode === 'url') {
          // URL langsung kadang dikunci ke IP server (YouTube 403) — unduh
          // dulu jadi file, lalu kirim (pola yang sama seperti Telegram).
          const dl = await downloadUrlFile(res.url, key);
          if (dl.size > MAX_BYTES) { await clearProc(); await sock.sendMessage(jid, { text: '\u274C Videonya kegedean (di atas \u00B145MB). Coba video lain yang lebih pendek.' }); return; }
          file = dl.file;
          tmpFiles.push(file);
        } else {
          if (res.size > MAX_BYTES) { await clearProc(); await sock.sendMessage(jid, { text: '\u274C Videonya kegedean (di atas \u00B145MB). Coba video lain yang lebih pendek.' }); return; }
          file = res.file;
          tmpFiles.push(file);
        }
        const title = (res.title || '').slice(0, 200);
        if (fmt === 'mp4') {
          await sock.sendMessage(jid, { video: { url: file }, caption: title || 'Video kamu', mimetype: 'video/mp4' });
        } else {
          await sock.sendMessage(jid, { audio: { url: file }, mimetype: 'audio/mpeg' });
        }
        await clearProc();
        console.log('WA_DL_OK jid=' + jid + ' fmt=' + fmt + ' route=' + res.route + ' ms=' + (Date.now() - t0));
        return;
      } catch (e) {
        lastErr = e;
        console.log('WA_DL_SEND_FAIL route=' + res.route + ' err=' + e.message);
      }
    }
    throw lastErr || new Error('CHAIN_FAIL');
  } catch (e) {
    console.log('WA_DL_FAIL jid=' + jid + ' fmt=' + fmt + ' ms=' + (Date.now() - t0) + ' err=' + e.message);
    await clearProc();
    await sock.sendMessage(jid, { text: waFailText(e) }).catch(() => {});
  } finally {
    busyWa.delete(key);
    activeWa = Math.max(0, activeWa - 1);
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  }
}

async function onMessagesUpsert({ messages }) {
  for (const m of messages || []) {
    try {
      if (!m || m.key.fromMe) continue;
      const jid = m.key.remoteJid || '';
      if (jid.endsWith('@g.us')) continue; // grup diabaikan (v1)
      if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) continue;
      const text = m.message && (m.message.conversation
        || (m.message.extendedTextMessage && m.message.extendedTextMessage.text)
        || (m.message.imageMessage && m.message.imageMessage.caption)
        || (m.message.videoMessage && m.message.videoMessage.caption));
      if (!text) continue;
      const t = String(text).trim();
      if (/^\/start\b/i.test(t)) {
        await sock.sendMessage(jid, { text: WA_START });
        continue;
      }
      const urlMatch = t.match(/https?:\/\/\S+/i);
      if (!urlMatch) {
        await sock.sendMessage(jid, { text: WA_START });
        continue;
      }
      await handleWADownload(jid, urlMatch[0], /mp3/i.test(t) ? 'mp3' : 'mp4');
    } catch (e) {
      console.log('WA_MSG_FAIL: ' + (e && e.message ? e.message : e));
    }
  }
}

module.exports = { startWA, requestPairingCodeNow, getWAStatus };
