// bot.js — Bot Telegram Downloader Video (TikTok / YouTube / Instagram).
// GRATIS — tanpa token (diubah 2026-11-13 atas perintah user).
// Alur: /start -> menu (teks saja) -> kirim link video -> video kekirim.
// Perintah /tiktok /youtube /instagram /help juga muncul di
// tombol Menu Telegram (kotak 4 persegi di bawah) — isinya sama dengan tombol
// inline di atas.
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { downloadUrlFile, checkYtDlp, platformOf, MAX_BYTES, validateMediaUrl, YTDLP_BIN } = require('./downloader');
const { videoChain, audioChain, spotifyChain, routeCounts, classifyError } = require('./routes');
const cache = require('./cache');

const TOKEN = process.env.BOT_TOKEN || '';
const OWNER = Number(process.env.OWNER_CHAT_ID || '6690512207');

// alamat Mini App (disajikan server toko lewat /miniapp)
const MINIAPP_URL = 'https://jajananbubro.web.id/miniapp';

if (!TOKEN) { console.error('BOT_TOKEN kosong di .env'); process.exit(1); }

// ---------- statistik (user + download + cache) ----------
// Dulu users.json / stats.json (file). Sekarang di cache.js: MySQL kalau
// env MYSQL_* diset, kalau tidak SQLite lokal (cache.db) — keduanya pakai
// TTL + cleanup berkala. Isi lama users.json/stats.json dimigrasi otomatis
// sekali saat start (lihat cache.js migrateLegacy).
function recordUser(msg) {
  if (!msg || !msg.chat) return;
  const from = msg.from || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '';
  cache.recordUser(msg.chat.id, name).catch(() => {});
}

// ---------- anti-DoS: 1 download per chat + rate limit + cap global ----------
// Tanpa ini satu user bisa spam link dan habisin disk/CPU (bot lag buat semua).
const busyDl = new Set(); // chatId yang lagi download
let activeDownloads = 0;
const MAX_CONCURRENT = 5;
const RL_WINDOW_MS = 10 * 60 * 1000;
const RL_MAX = 10; // maks 10 download per 10 menit per chat
const rlHits = new Map(); // chatId -> [timestamp]
function rateLimited(chatId) {
  const now = Date.now();
  const arr = (rlHits.get(chatId) || []).filter((t) => now - t < RL_WINDOW_MS);
  if (arr.length >= RL_MAX) { rlHits.set(chatId, arr); return true; }
  arr.push(now);
  rlHits.set(chatId, arr);
  return false;
}
async function acquireSlot(chatId) {
  if (busyDl.has(chatId)) return 'busy';
  if (activeDownloads >= MAX_CONCURRENT) return 'global-busy';
  if (rateLimited(chatId)) return 'rate';
  busyDl.add(chatId);
  activeDownloads++;
  return 'ok';
}
function releaseSlot(chatId) {
  busyDl.delete(chatId);
  activeDownloads = Math.max(0, activeDownloads - 1);
}

const modes = {}; // chatId -> 'tiktok' | 'youtube' | 'instagram' (tombol download yang dipencet)

const bot = new TelegramBot(TOKEN, { polling: true });

const MENU_KB = {
  reply_markup: {
    inline_keyboard: [
      [{ text: 'DOWNLOAD TIKTOK', callback_data: 'dl_tiktok', style: 'primary' }, { text: 'DOWNLOAD YT', callback_data: 'dl_yt', style: 'danger' }],
      [{ text: 'DOWNLOAD IG', callback_data: 'dl_ig', style: 'success' }, { text: 'DOWNLOAD SPOTIFY 🎵', callback_data: 'dl_spotify', style: 'success' }],
    ],
  },
};

// keyboard bawah permanen (ikon kotak 4 persegi di samping kolom pesan) —
// isinya sama dengan tombol inline di atas. Sekali dikirim, nempel di chat.
const REPLY_KB = {
  reply_markup: {
    keyboard: [
      [{ text: 'DOWNLOAD TIKTOK', style: 'primary' }, { text: 'DOWNLOAD YT', style: 'danger' }],
      [{ text: 'DOWNLOAD IG', style: 'success' }, { text: 'DOWNLOAD SPOTIFY', style: 'success' }],
    ],
    resize_keyboard: true,
  },
};

const HELP = '📝 Panduan — GRATIS, tanpa token\n\n'
  + '1️⃣ Pencet tombol DOWNLOAD sesuai platform, lalu kirim link-nya.\n'
  + '2️⃣ Video (TikTok/YouTube/Instagram): pilih format MP4 (video) atau MP3 (audio). Video dikirim ke kamu (maksimal ±15 detik).\n'
  + '3️⃣ Spotify: kirim link lagunya, langsung jadi MP3 (audio saja, judul ikut lagu Spotify).\n\n'
  + '⚠️ Video/audio di atas ±45MB tidak bisa dikirim bot Telegram.\n\n'
  + 'Perintah cepat (tombol Menu di bawah): /tiktok /youtube /instagram /spotify';

function sendWelcome(chatId, disp) {
  const txt = 'Haii 👋 ' + (disp || 'Kak') + ' , Silahkan pilih menu dibawah untuk melanjutkan';
  bot.sendMessage(chatId, txt, MENU_KB);
  return bot.sendMessage(chatId, '👇', REPLY_KB);
}

bot.onText(/\/start/, (msg) => { sendWelcome(msg.chat.id, msg.from.username ? '@' + msg.from.username : (msg.from.first_name || 'Kak')); });
bot.onText(/\/stats/, async (msg) => {
  if (msg.chat.id !== OWNER) return;
  try {
    const s = await cache.getStats();
    const rs = await cache.getRouteStats();
    const counts = routeCounts();
    let txt = '📊 Statistik bot\n'
      + '👥 Total user: ' + s.users + '\n'
      + '⬇️ Total download berhasil: ' + s.downloads + '\n'
      + '💾 Cache: ' + s.cacheRows + ' entri (TTL ' + s.ttlDays + ' hari, backend ' + s.backend + ')\n'
      + '🔀 Jalur per platform: ' + Object.entries(counts).map(([k, v]) => k + ' ' + v).join(', ') + '\n\n'
      + '🛣️ Kesehatan jalur:\n';
    if (!rs.length) txt += '(belum ada percobaan tercatat)\n';
    for (const r of rs) {
      txt += '• ' + r.route + ' [' + r.platform + '] ✅' + r.ok_count + ' ❌' + r.fail_count;
      if (r.last_error) txt += ' — terakhir: ' + String(r.last_error).slice(0, 60);
      txt += '\n';
    }
    bot.sendMessage(msg.chat.id, txt);
  } catch (e) {
    bot.sendMessage(msg.chat.id, '📊 Statistik gagal dibaca: ' + e.message);
  }
});
bot.onText(/\/saldo/, (msg) => {
  bot.sendMessage(msg.chat.id, '💎 Download sekarang GRATIS, nggak perlu token lagi. Kirim link videonya aja.');
});
bot.onText(/\/help/, (msg) => { bot.sendMessage(msg.chat.id, HELP, MENU_KB); });

// ---------- perintah Menu (dipakai tombol inline + perintah /...) ----------
const GRATIS_MSG = '💎 Download sekarang GRATIS, nggak perlu top up token lagi. Kirim link videonya aja.';
async function askDownload(chatId, plat) {
  const label = plat === 'tiktok' ? 'TikTok' : plat === 'youtube' ? 'YouTube' : plat === 'instagram' ? 'Instagram' : plat === 'spotify' ? 'Spotify' : 'TikTok / YouTube / Instagram';
  if (plat) modes[chatId] = plat;
  return bot.sendMessage(chatId, '📥 Kirim link ' + label + ' kamu.');
}
bot.onText(/\/topup/, (msg) => { bot.sendMessage(msg.chat.id, GRATIS_MSG); });
bot.onText(/\/tiktok/, (msg) => { askDownload(msg.chat.id, 'tiktok'); });
bot.onText(/\/youtube/, (msg) => { askDownload(msg.chat.id, 'youtube'); });
bot.onText(/\/instagram/, (msg) => { askDownload(msg.chat.id, 'instagram'); });
bot.onText(/\/spotify/, (msg) => { askDownload(msg.chat.id, 'spotify'); });

// ---------- download ----------
// Pesan gagal JUJUR berdasarkan penyebab — bukan "video privat" kalau yang
// kena limit/bot-check. Klasifikasi dari routes.classifyError.
function failTextFor(err) {
  const failures = (err && err.failures) || [];
  const cls = (err && err.cls) || classifyError(err);
  if (failures.some((f) => f.cls === 'LIMIT')) return '❌ API TikTok lagi kena limit harian (jatah gratis 10.000/hari, dipake bareng). Limit reset tiap jam 07:00 WIB — coba lagi besok pagi. YouTube/Instagram tetap jalan.';
  if (cls === 'BOTCHECK' || failures.some((f) => f.cls === 'BOTCHECK')) return '❌ YouTube lagi nge-blokir download dari server bot (bot-check), bukan salah link kamu. Semua jalur cadangan juga kena — coba lagi beberapa menit lagi.';
  if (failures.some((f) => f.cls === 'DOWN')) return '❌ Server API TikTok (tikwm) lagi down/error, bukan salah link kamu. Coba lagi nanti. YouTube/Instagram tetap jalan.';
  if (cls === 'NOTFOUND' || failures.some((f) => f.cls === 'NOTFOUND')) return '❌ Videonya nggak ketemu / privat / login-only. Pastikan link-nya publik.';
  if (cls === 'NETWORK' || failures.some((f) => f.cls === 'NETWORK')) return '❌ Koneksi ke server video lagi bermasalah. Coba lagi bentar.';
  return '❌ Gagal ambil video. Coba link lain, atau pastikan videonya publik (bukan privat/login-only).';
}
const TOO_BIG_MSG = '❌ Videonya kegedean (di atas ±45MB), bot Telegram nggak bisa kirim. Coba video lain yang lebih pendek.';

async function handleDownload(chatId, url, format, statusMsgId) {
  const t0 = Date.now();
  const fmt = format === 'mp3' ? 'mp3' : 'mp4';
  // Validasi link (domain allowlist + tolak host privat). Regex lama tidak
  // di-anchor — link jebakan seperti https://jahat.com/?x=youtube.com lolos.
  const v = validateMediaUrl(url);
  if (!v.ok) {
    const txt = '❌ Link nggak bisa diproses (' + v.reason + '). Kirim link TikTok / YouTube / Instagram yang publik ya.';
    if (statusMsgId) return bot.editMessageText(txt, { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
    return bot.sendMessage(chatId, txt);
  }
  url = v.url;
  const plat = v.platform || platformOf(url);
  const slot = await acquireSlot(chatId);
  if (slot !== 'ok') {
    const txt = slot === 'busy' ? '⏳ Masih ada download kamu yang jalan, tunggu selesai dulu ya.'
      : slot === 'rate' ? '⏳ Kebanyakan request, tunggu bentar ya (maks 10 download per 10 menit).'
      : '⏳ Bot lagi sibuk, coba lagi bentar ya.';
    if (statusMsgId) return bot.editMessageText(txt, { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
    return bot.sendMessage(chatId, txt);
  }
  let proc;
  if (statusMsgId) {
    proc = { message_id: statusMsgId };
    await bot.editMessageText('⏳ Lagi diproses (' + fmt.toUpperCase() + '), bentar ya…', { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
  } else {
    proc = await bot.sendMessage(chatId, '⏳ Lagi diproses (' + fmt.toUpperCase() + '), bentar ya…');
  }
  const fail = (txt) => bot.editMessageText(txt, { chat_id: chatId, message_id: proc.message_id }).catch(() => {});
  const done = () => bot.deleteMessage(chatId, proc.message_id).catch(() => {});
  const tmpFiles = [];
  try {
    // 0. Cache dulu: link yang sama pernah dikirim → kirim ulang file_id
    // Telegram (tanpa download ulang). Entri kedaluwarsa 7 hari (TTL).
    const cached = await cache.getCache(plat, url, fmt).catch(() => null);
    if (cached && cached.file_id) {
      try {
        if (fmt === 'mp4') await bot.sendVideo(chatId, cached.file_id, { caption: (cached.title || 'Video kamu').slice(0, 200) });
        else await bot.sendAudio(chatId, cached.file_id, { caption: '🎵 ' + (cached.title || 'Audio kamu'), title: cached.title || undefined });
        await done();
        await cache.incDownloads().catch(() => {});
        console.log('DL_CACHE_OK chat=' + chatId + ' fmt=' + fmt + ' ms=' + (Date.now() - t0));
        return;
      } catch (e) { console.log('DL_CACHE_STALE chat=' + chatId + ' err=' + e.message); }
    }
    // 1. Rantai fallback: tiap hasil dicoba dikirim; kalau kirim gagal,
    // lanjut ke jalur berikutnya (generator berhenti sendiri kalau habis).
    const gen = fmt === 'mp4' ? videoChain(plat, url, chatId) : audioChain(plat, url, chatId);
    let lastErr = null;
    for await (const res of gen) {
      try {
        let fileId = null;
        let title = res.title || '';
        let size = res.size || 0;
        if (fmt === 'mp4') {
          const caption = (title ? title.slice(0, 200) : 'Video kamu');
          if (res.mode === 'url') {
            try {
              const msg = await bot.sendVideo(chatId, res.url, { caption });
              fileId = msg.video && msg.video.file_id;
            } catch (e) {
              // URL valid tapi server Telegram ditolak ambil (link dikunci
              // ke IP server) — unduh file-nya lalu kirim sebagai file.
              console.log('DL_URL_FAIL chat=' + chatId + ' route=' + res.route + ' err=' + e.message);
              const dl = await downloadUrlFile(res.url, chatId);
              if (dl.size > MAX_BYTES) { await fail(TOO_BIG_MSG); return; }
              tmpFiles.push(dl.file);
              const msg = await bot.sendVideo(chatId, dl.file, { caption });
              fileId = msg.video && msg.video.file_id;
              size = dl.size;
            }
          } else {
            if (res.size > MAX_BYTES) { await fail(TOO_BIG_MSG); return; }
            tmpFiles.push(res.file);
            const msg = await bot.sendVideo(chatId, res.file, { caption });
            fileId = msg.video && msg.video.file_id;
          }
        } else {
          if (res.size > MAX_BYTES) { await fail(TOO_BIG_MSG); return; }
          tmpFiles.push(res.file);
          const audioOpts = { caption: title ? '🎵 ' + title : '🎵 Audio kamu' };
          if (title) audioOpts.title = title;
          if (res.performer) audioOpts.performer = res.performer;
          if (res.duration) audioOpts.duration = Math.round(res.duration);
          const msg = await bot.sendAudio(chatId, res.file, audioOpts);
          fileId = msg.audio && msg.audio.file_id;
        }
        // Berhasil terkirim → simpan ke cache (file_id Telegram) + hitung.
        if (fileId) await cache.setCache(plat, url, fmt, fileId, title, size, res.route).catch(() => {});
        await cache.incDownloads().catch(() => {});
        await done();
        console.log('DL_OK chat=' + chatId + ' fmt=' + fmt + ' route=' + res.route + ' ms=' + (Date.now() - t0) + ' size=' + size + ' title=' + (title || '-'));
        return;
      } catch (e) {
        lastErr = e;
        console.log('DL_SEND_FAIL chat=' + chatId + ' route=' + res.route + ' err=' + e.message);
        // lanjut ke jalur berikutnya
      }
    }
    // Semua jalur habis tanpa ada yang berhasil terkirim.
    throw lastErr || new Error('CHAIN_FAIL');
  } catch (e) {
    if (e.message === 'TOO_BIG') { await fail(TOO_BIG_MSG); return; }
    console.log('DL_FAIL chat=' + chatId + ' fmt=' + fmt + ' ms=' + (Date.now() - t0) + ' err=' + e.message);
    await fail(failTextFor(e));
  } finally {
    releaseSlot(chatId);
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  }
}

// ---------- Spotify (langsung MP3, tanpa pilih format) ----------
// Audio diambil dari YouTube (lagu yang sama), karena file Spotify dikunci
// DRM. Judul + artis ikut data Spotify. Rantai: ytsearch android dulu,
// web cadangan.
async function handleSpotify(chatId, url) {
  const t0 = Date.now();
  const v = validateMediaUrl(url);
  if (!v.ok || v.platform !== 'spotify') {
    return bot.sendMessage(chatId, '❌ Link Spotify nggak valid. Kirim link track Spotify yang publik ya.');
  }
  url = v.url;
  const slot = await acquireSlot(chatId);
  if (slot !== 'ok') {
    return bot.sendMessage(chatId, slot === 'busy' ? '⏳ Masih ada download kamu yang jalan, tunggu selesai dulu ya.'
      : slot === 'rate' ? '⏳ Kebanyakan request, tunggu bentar ya (maks 10 download per 10 menit).'
      : '⏳ Bot lagi sibuk, coba lagi bentar ya.');
  }
  const proc = await bot.sendMessage(chatId, '⏳ Lagi diproses (SPOTIFY → MP3), bentar ya…');
  const fail = (txt) => bot.editMessageText(txt, { chat_id: chatId, message_id: proc.message_id }).catch(() => {});
  const done = () => bot.deleteMessage(chatId, proc.message_id).catch(() => {});
  const tmpFiles = [];
  try {
    const cached = await cache.getCache('spotify', url, 'mp3').catch(() => null);
    if (cached && cached.file_id) {
      try {
        await bot.sendAudio(chatId, cached.file_id, { caption: '🎵 ' + (cached.title || 'Lagu kamu'), title: cached.title || undefined });
        await done();
        await cache.incDownloads().catch(() => {});
        console.log('SPOTIFY_CACHE_OK chat=' + chatId + ' ms=' + (Date.now() - t0));
        return;
      } catch (e) { console.log('SPOTIFY_CACHE_STALE chat=' + chatId + ' err=' + e.message); }
    }
    let lastErr = null;
    for await (const res of spotifyChain(url, chatId)) {
      try {
        if (res.size > MAX_BYTES) { await fail('❌ Audionya kegedean (di atas ±45MB), bot Telegram nggak bisa kirim. Coba lagu lain.'); return; }
        tmpFiles.push(res.file);
        const title = res.title || '';
        const audioOpts = { caption: '🎵 ' + title + (res.performer ? ' — ' + res.performer : '') };
        if (title) audioOpts.title = title;
        if (res.performer) audioOpts.performer = res.performer;
        if (res.duration) audioOpts.duration = Math.round(res.duration);
        const msg = await bot.sendAudio(chatId, res.file, audioOpts);
        const fileId = msg.audio && msg.audio.file_id;
        if (fileId) await cache.setCache('spotify', url, 'mp3', fileId, title, res.size || 0, res.route).catch(() => {});
        await cache.incDownloads().catch(() => {});
        await done();
        console.log('SPOTIFY_OK chat=' + chatId + ' route=' + res.route + ' ms=' + (Date.now() - t0) + ' size=' + (res.size || 0) + ' title=' + title);
        return;
      } catch (e) {
        lastErr = e;
        console.log('SPOTIFY_SEND_FAIL chat=' + chatId + ' route=' + res.route + ' err=' + e.message);
      }
    }
    throw lastErr || new Error('CHAIN_FAIL');
  } catch (e) {
    if (e.message === 'TOO_BIG') { await fail('❌ Audionya kegedean (di atas ±45MB), bot Telegram nggak bisa kirim. Coba lagu lain.'); return; }
    console.log('SPOTIFY_FAIL chat=' + chatId + ' ms=' + (Date.now() - t0) + ' err=' + e.message);
    await fail('❌ Gagal ambil lagu Spotify. Pastikan link-nya lagu (track) Spotify yang publik, lalu coba lagi.');
  } finally {
    releaseSlot(chatId);
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  }
}

// link yang nunggu dipilih formatnya (MP4/MP3) — chatId -> { url }
const pendingDl = {};

bot.on('message', async (msg) => {
  recordUser(msg);
  // kiriman dari Mini App (tombol Download di web app) — data JSON {type, url, format, platform}
  if (msg.web_app_data && msg.web_app_data.data) {
    const chatId = msg.chat.id;
    let d = null;
    try { d = JSON.parse(msg.web_app_data.data); } catch (_) {}
    if (!d || !d.url) return bot.sendMessage(chatId, 'Link-nya nggak kebaca dari Mini App, coba kirim ulang ya.');
    const fmt = d.format === 'mp3' ? 'mp3' : 'mp4';
    console.log('MINIAPP_DL chat=' + chatId + ' fmt=' + fmt + ' url=' + d.url);
    const v = validateMediaUrl(d.url);
    if (!v.ok) return bot.sendMessage(chatId, 'Link-nya bukan dari YouTube/TikTok/Instagram/Spotify. Coba link lain ya.');
    if (v.platform === 'spotify') return handleSpotify(chatId, v.url);
    return handleDownload(chatId, v.url, fmt);
  }
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  // 0. link media (TikTok/YouTube/Instagram/Spotify) — validasi domain
  // di-anchor (validateMediaUrl), bukan regex longgar. Spotify langsung MP3,
  // yang lain tanya format dulu (MP4/MP3).
  const v = validateMediaUrl(text);
  if (v.ok) {
    const want = modes[chatId];
    if (want && v.platform && v.platform !== want) {
      const label = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', spotify: 'Spotify' };
      return bot.sendMessage(chatId, 'Itu link ' + (label[v.platform] || 'lain') + ', kamu pencet DOWNLOAD ' + want.toUpperCase() + '. Kirim link ' + (label[want] || '') + ' ya, atau pencet tombol yang sesuai.');
    }
    delete modes[chatId];
    if (v.platform === 'spotify') return handleSpotify(chatId, v.url);
    pendingDl[chatId] = { url: v.url };
    return bot.sendMessage(chatId, '🎵 Pilih format download:', {
      reply_markup: { inline_keyboard: [[{ text: '🎬 MP4 (video)', callback_data: 'fmt_mp4', style: 'primary' }, { text: '🎵 MP3 (audio)', callback_data: 'fmt_mp3', style: 'success' }]] },
    });
  }
  // 1b. tombol keyboard bawah (ikon kotak) — teksnya sama dengan tombol inline
  if (text === '💎 TOP UP TOKEN') return bot.sendMessage(chatId, GRATIS_MSG);
  if (text === 'DOWNLOAD TIKTOK') return askDownload(chatId, 'tiktok');
  if (text === 'DOWNLOAD YT') return askDownload(chatId, 'youtube');
  if (text === 'DOWNLOAD IG') return askDownload(chatId, 'instagram');
  if (text === 'DOWNLOAD SPOTIFY') return askDownload(chatId, 'spotify');
  // 2. teks lain -> arahkan
  bot.sendMessage(chatId, 'Kirim link video TikTok / YouTube / Instagram, atau pencet tombol di bawah.', MENU_KB);
});

// ---------- tombol ----------
bot.on('callback_query', async (q) => {
  recordUser({ chat: q.message.chat, from: q.from });
  const chatId = q.message.chat.id;
  const data = q.data || '';
  try { await bot.answerCallbackQuery(q.id); } catch (e) {}
  if (data === 'topup' || data === 'menu_buy' || data === 'menu_tokens') {
    return bot.sendMessage(chatId, GRATIS_MSG);
  }
  // pilih format: MP4 (video) / MP3 (audio) buat link yang barusan dikirim
  if (data === 'fmt_mp4' || data === 'fmt_mp3') {
    const p = pendingDl[chatId];
    if (!p) return bot.sendMessage(chatId, 'Link-nya udah nggak ada — kirim ulang link videonya ya.');
    delete pendingDl[chatId];
    return handleDownload(chatId, p.url, data === 'fmt_mp3' ? 'mp3' : 'mp4', q.message.message_id);
  }
  if (data === 'dl_tiktok' || data === 'dl_yt' || data === 'dl_ig' || data === 'dl_spotify' || data === 'menu_dl') {
    const plat = data === 'dl_tiktok' ? 'tiktok' : data === 'dl_yt' ? 'youtube' : data === 'dl_ig' ? 'instagram' : data === 'dl_spotify' ? 'spotify' : null;
    return askDownload(chatId, plat);
  }
  if (data === 'menu_help') {
    return bot.sendMessage(chatId, HELP, MENU_KB);
  }
});

bot.on('polling_error', (e) => { console.log('polling_error:', e.message || e); });

// kalau koneksi ke Telegram putus tiba-tiba (socket hang up dsb), library
// kadang lempar error-nya sebagai unhandled rejection — tanpa ini Node
// langsung mati (kejadian 19 Nov 14:01 + 14:04, tombol jadi nggak bisa
// dipencet karena bot-nya udah mati). Error jaringan begini cuma dicatat,
// bot tetap jalan, polling lanjut sendiri. Error lain tetap dimatiin biar
// watchdog yang nyalain ulang (jangan ditelan mentah-mentah).
const ERR_JARINGAN = ['EFATAL', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'];
function errJaringan(e) {
  const kode = (e && e.code) || '';
  const pesan = String((e && e.message) || e || '');
  return ERR_JARINGAN.includes(kode) || /socket hang up|network|timed out/i.test(pesan);
}
process.on('unhandledRejection', (e) => {
  if (errJaringan(e)) { console.log('unhandledRejection (jaringan, lanjut):', (e && e.message) || e); return; }
  console.log('unhandledRejection (fatal):', e);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  if (errJaringan(e)) { console.log('uncaughtException (jaringan, lanjut):', (e && e.message) || e); return; }
  console.log('uncaughtException (fatal):', e);
  process.exit(1);
});

// ---------- antrian Mini App (download dari Menu Button) ----------
// Mini App kirim request ke server toko (/api/miniapp-download) yang
// disimpan jadi file di folder ini. Bot baca tiap 3 detik, download,
// kirim hasilnya ke chat. Jadi download dari Menu Button pun file-nya
// tetap kekirim lewat chat.
const MINIAPP_QDIR = __dirname + '/miniapp_queue';
let qBusy = false;
async function cekAntrianMiniApp() {
  if (qBusy) return;
  let files = [];
  try { files = fs.readdirSync(MINIAPP_QDIR).filter((f) => f.endsWith('.json')); } catch (_) { return; }
  if (!files.length) return;
  qBusy = true;
  try {
    for (const f of files) {
      const fp = MINIAPP_QDIR + '/' + f;
      let d = null;
      try { d = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch (_) {}
      try { fs.unlinkSync(fp); } catch (_) {}
      if (!d || !d.url || !d.chatId) continue;
      const cid = Number(d.chatId);
      if (!cid) continue;
      const fmt = d.format === 'mp3' ? 'mp3' : 'mp4';
      console.log('MINIAPP_Q chat=' + cid + ' fmt=' + fmt + ' url=' + d.url);
      try {
        const v = validateMediaUrl(d.url);
        if (v.platform === 'spotify') await handleSpotify(cid, v.url);
        else if (v.ok) await handleDownload(cid, v.url, fmt);
        else await bot.sendMessage(cid, 'Link-nya bukan dari YouTube/TikTok/Instagram/Spotify. Coba link lain ya.');
      } catch (e) { console.log('MINIAPP_Q_FAIL chat=' + cid + ' err=' + e.message); }
    }
  } finally {
    qBusy = false;
  }
}
setInterval(cekAntrianMiniApp, 3000);

(async () => {
  const backend = await cache.init().catch((e) => { console.log('CACHE init gagal, lanjut tanpa cache: ' + e.message); return 'none'; });
  console.log('Cache backend: ' + backend + ' (TTL ' + cache.TTL_DAYS + ' hari)');
  const v = await checkYtDlp();
  console.log(v ? 'yt-dlp OK: ' + v + ' @ ' + YTDLP_BIN : 'yt-dlp TIDAK KETEMU — download akan gagal (postinstall gagal unduh binary, cek log npm install)');
  console.log('Bot downloader jalan (polling). Owner: ' + OWNER);
})();
