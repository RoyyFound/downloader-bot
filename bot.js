// bot.js — Bot Telegram Downloader Video (TikTok / YouTube / Instagram).
// GRATIS — tanpa token (diubah 2026-11-13 atas perintah user).
// Alur: /start -> menu (teks saja) -> kirim link video -> video kekirim.
// Perintah /tiktok /youtube /instagram /help juga muncul di
// tombol Menu Telegram (kotak 4 persegi di bawah) — isinya sama dengan tombol
// inline di atas.
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const { extractDirect, downloadFile, downloadUrlFile, extractAudioInfo, downloadAudioFile, downloadAudioUrlFile, fetchTikwm, fetchSpotifyMeta, isSpotifyUrl, checkYtDlp, isVideoUrl, platformOf, MAX_BYTES } = require('./downloader');

const TOKEN = process.env.BOT_TOKEN || '';
const OWNER = Number(process.env.OWNER_CHAT_ID || '6690512207');

// alamat Mini App (disajikan server toko lewat /miniapp)
const MINIAPP_URL = 'https://jajananbubro.web.id/miniapp';

if (!TOKEN) { console.error('BOT_TOKEN kosong di .env'); process.exit(1); }

// ---------- statistik (user + download) ----------
// users.json: { chatId: { name, first } } — dicatat saat ada chat masuk.
// stats.json: { downloads } — naik tiap download berhasil dikirim.
// /stats (owner saja) menampilkan totalnya.
const USERS_FILE = __dirname + '/users.json';
const STATS_FILE = __dirname + '/stats.json';
let users = {};
let stats = { downloads: 0 };
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8') || '{}'); if (typeof users !== 'object' || Array.isArray(users)) users = {}; } catch (_) { users = {}; }
try { const s = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8') || '{}'); if (typeof s.downloads === 'number') stats.downloads = s.downloads; } catch (_) {}
function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) { console.log('SAVE_USERS_FAIL ' + e.message); } }
function saveStats() { try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats)); } catch (e) { console.log('SAVE_STATS_FAIL ' + e.message); } }
function recordUser(msg) {
  if (!msg || !msg.chat) return;
  const id = String(msg.chat.id);
  if (!users[id]) {
    const from = msg.from || {};
    users[id] = { name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '', first: new Date().toISOString() };
    saveUsers();
  }
}

const modes = {}; // chatId -> 'tiktok' | 'youtube' | 'instagram' (tombol download yang dipencet)

const bot = new TelegramBot(TOKEN, { polling: true });

const MENU_KB = {
  reply_markup: {
    inline_keyboard: [
      [{ text: 'DOWNLOAD TIKTOK', callback_data: 'dl_tiktok' }],
      [{ text: 'DOWNLOAD YT', callback_data: 'dl_yt' }],
      [{ text: 'DOWNLOAD IG', callback_data: 'dl_ig' }],
      [{ text: 'DOWNLOAD SPOTIFY 🎵', callback_data: 'dl_spotify' }],
    ],
  },
};

// keyboard bawah permanen (ikon kotak 4 persegi di samping kolom pesan) —
// isinya sama dengan tombol inline di atas. Sekali dikirim, nempel di chat.
const REPLY_KB = {
  reply_markup: {
    keyboard: [
      [{ text: 'DOWNLOAD TIKTOK' }],
      [{ text: 'DOWNLOAD YT' }],
      [{ text: 'DOWNLOAD IG' }],
      [{ text: 'DOWNLOAD SPOTIFY' }],
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
bot.onText(/\/stats/, (msg) => {
  if (msg.chat.id !== OWNER) return;
  bot.sendMessage(msg.chat.id, '📊 Statistik bot\n👥 Total user: ' + Object.keys(users).length + '\n⬇️ Total download berhasil: ' + stats.downloads);
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
async function handleDownload(chatId, url, format, statusMsgId) {
  const t0 = Date.now();
  const fmt = format === 'mp3' ? 'mp3' : 'mp4';
  let proc;
  if (statusMsgId) {
    proc = { message_id: statusMsgId };
    await bot.editMessageText('⏳ Lagi diproses (' + fmt.toUpperCase() + '), bentar ya…', { chat_id: chatId, message_id: statusMsgId }).catch(() => {});
  } else {
    proc = await bot.sendMessage(chatId, '⏳ Lagi diproses (' + fmt.toUpperCase() + '), bentar ya…');
  }
  const fail = (txt) => bot.editMessageText(txt, { chat_id: chatId, message_id: proc.message_id }).catch(() => {});
  const done = () => bot.deleteMessage(chatId, proc.message_id).catch(() => {});
  const plat = platformOf(url);

  // ===== MP3 (audio saja, nama file + judul ikut judul video) =====
  if (fmt === 'mp3') {
    let audioFile = null;
    let trackTitle = '';
    let trackPerformer = '';
    let trackDuration = 0;
    try {
      // TikTok: musiknya langsung dari API tikwm (mp3, cepat, tanpa ffmpeg).
      if (plat === 'tiktok') {
        try {
          const tk = await fetchTikwm(url);
          if (tk.musicUrl) {
            console.log('TT_MUSIC_OK chat=' + chatId);
            trackTitle = tk.musicTitle || tk.title || '';
            trackPerformer = tk.musicAuthor || '';
            audioFile = await downloadAudioUrlFile(tk.musicUrl, chatId, trackTitle);
          }
        } catch (e) { console.log('TT_MUSIC_FAIL chat=' + chatId + ' err=' + e.message); }
      }
      // Jalur umum: yt-dlp extract audio -> ffmpeg jadi mp3 (nama file = judul).
      if (!audioFile) {
        const info = await extractAudioInfo(url);
        trackTitle = info.title || '';
        trackPerformer = info.uploader || '';
        trackDuration = info.duration || 0;
        if (info.tooBig) {
          console.log('DL_MP3_TOO_BIG chat=' + chatId + ' size=' + info.size);
          return fail('❌ Audionya kegedean (di atas ±45MB), bot Telegram nggak bisa kirim. Coba video lain yang lebih pendek.');
        }
        audioFile = await downloadAudioFile(url, chatId);
        if (!trackTitle) trackTitle = audioFile.title || '';
      }
      if (audioFile.size > MAX_BYTES) {
        console.log('DL_MP3_TOO_BIG chat=' + chatId + ' size=' + audioFile.size);
        return fail('❌ Audionya kegedean (di atas ±45MB), bot Telegram nggak bisa kirim. Coba video lain yang lebih pendek.');
      }
      const audioOpts = { caption: trackTitle ? '🎵 ' + trackTitle : '🎵 Audio kamu' };
      if (trackTitle) audioOpts.title = trackTitle;
      if (trackPerformer) audioOpts.performer = trackPerformer;
      if (trackDuration) audioOpts.duration = Math.round(trackDuration);
      await bot.sendAudio(chatId, audioFile.file, audioOpts);
      await done();
      stats.downloads++; saveStats();
      console.log('DL_MP3_OK chat=' + chatId + ' ms=' + (Date.now() - t0) + ' size=' + audioFile.size + ' title=' + (trackTitle || '-'));
    } catch (e) {
      console.log('DL_MP3_FAIL chat=' + chatId + ' ms=' + (Date.now() - t0) + ' err=' + e.message);
      await fail('❌ Gagal ambil audio. Coba link lain, atau pastikan videonya publik (bukan privat/login-only).');
    } finally {
      if (audioFile && audioFile.file) { try { fs.unlinkSync(audioFile.file); } catch (_) {} }
    }
    return;
  }

  // ===== MP4 (video, jalur lama) =====
  let d = null;
  let tikwmLimited = false; // API TikTok (tikwm) kena limit harian — pesannya beda
  // TikTok: coba API tikwm dulu (yt-dlp sering gagal karena IP HP diblokir).
  if (plat === 'tiktok') {
    try {
      d = await fetchTikwm(url);
      console.log('TT_API_OK chat=' + chatId);
    } catch (e) {
      console.log('TT_API_FAIL chat=' + chatId + ' err=' + e.message);
      if (String(e.message || '').startsWith('TIKWM_LIMIT')) tikwmLimited = true;
    }
  }
  if (!d) {
    try {
      d = await extractDirect(url);
    } catch (e) {
      // Shorts/video baru YouTube sering cuma punya format DASH terpisah
      // (tanpa 18/22) — link langsung ga bisa diambil, tapi file-nya masih
      // bisa diunduh + digabung ffmpeg. Jangan gagal di sini, lanjut jalur 2.
      console.log('DL_EXTRACT_FAIL chat=' + chatId + ' ms=' + (Date.now() - t0) + ' err=' + e.message);
      d = null;
    }
  }
  if (d && d.tooBig) {
    await fail('❌ Videonya kegedean (di atas ±45MB), bot Telegram nggak bisa kirim. Coba video lain yang lebih pendek.');
    return;
  }
  const caption = (d && d.title ? d.title.slice(0, 200) : 'Video kamu');
  // Jalur 1: kirim lewat URL (cepat) — cuma kalau extract berhasil.
  if (d) {
    try {
      await bot.sendVideo(chatId, d.url, { caption });
      await done();
      stats.downloads++; saveStats();
      console.log('DL_OK chat=' + chatId + ' ms=' + (Date.now() - t0));
      return;
    } catch (e) {
      // URL-nya valid tapi server Telegram ditolak ambil (link YouTube dikunci
      // ke IP HP) — lanjut jalur 2: unduh file lalu upload.
      console.log('DL_URL_FAIL chat=' + chatId + ' ms=' + (Date.now() - t0) + ' err=' + e.message);
    }
  }
  // Jalur 2: unduh file ke HP, kirim sebagai file.
  let dlFile = null;
  try {
    dlFile = (d && d.via === 'tikwm') ? await downloadUrlFile(d.url, chatId) : await downloadFile(url, chatId);
    if (dlFile.size > MAX_BYTES) {
      await fail('❌ Videonya kegedean (di atas ±45MB), bot Telegram nggak bisa kirim. Coba video lain yang lebih pendek.');
      return;
    }
    await bot.sendVideo(chatId, dlFile.file, { caption });
    await done();
    stats.downloads++; saveStats();
    console.log('DL_OK_FILE chat=' + chatId + ' ms=' + (Date.now() - t0));
  } catch (e) {
    console.log('DL_FAIL chat=' + chatId + ' ms=' + (Date.now() - t0) + ' err=' + e.message);
    if (tikwmLimited) {
      await fail('❌ API TikTok lagi kena limit harian (jatah gratis 10.000/hari, dipake bareng). Limit reset tiap jam 07:00 WIB — coba lagi besok pagi. YouTube/Instagram tetap jalan.');
    } else {
      await fail('❌ Gagal ambil video. Coba link lain, atau pastikan videonya publik (bukan privat/login-only).');
    }
  } finally {
    if (dlFile && dlFile.file) { try { fs.unlinkSync(dlFile.file); } catch (_) {} }
  }
}

// ---------- Spotify (langsung MP3, tanpa pilih format) ----------
// Audio diambil dari YouTube (lagu yang sama), karena file Spotify dikunci
// DRM. Judul + artis ikut data Spotify.
async function handleSpotify(chatId, url) {
  const t0 = Date.now();
  const proc = await bot.sendMessage(chatId, '⏳ Lagi diproses (SPOTIFY → MP3), bentar ya…');
  const fail = (txt) => bot.editMessageText(txt, { chat_id: chatId, message_id: proc.message_id }).catch(() => {});
  const done = () => bot.deleteMessage(chatId, proc.message_id).catch(() => {});
  let audioFile = null;
  try {
    const meta = await fetchSpotifyMeta(url);
    console.log('SPOTIFY_META_OK chat=' + chatId + ' title=' + meta.title + ' artist=' + meta.artist);
    const query = (meta.artist ? meta.artist + ' - ' : '') + meta.title;
    const searchUrl = 'ytsearch1:' + query;
    const info = await extractAudioInfo(searchUrl);
    if (info.tooBig) {
      console.log('SPOTIFY_TOO_BIG chat=' + chatId + ' size=' + info.size);
      return fail('❌ Audionya kegedean (di atas ±45MB), bot Telegram nggak bisa kirim. Coba lagu lain.');
    }
    audioFile = await downloadAudioFile(searchUrl, chatId, query);
    if (audioFile.size > MAX_BYTES) {
      console.log('SPOTIFY_TOO_BIG chat=' + chatId + ' size=' + audioFile.size);
      return fail('❌ Audionya kegedean (di atas ±45MB), bot Telegram nggak bisa kirim. Coba lagu lain.');
    }
    const audioOpts = { caption: '🎵 ' + meta.title + (meta.artist ? ' — ' + meta.artist : '') };
    audioOpts.title = meta.title;
    if (meta.artist) audioOpts.performer = meta.artist;
    if (info.duration) audioOpts.duration = Math.round(info.duration);
    await bot.sendAudio(chatId, audioFile.file, audioOpts);
    await done();
    stats.downloads++; saveStats();
    console.log('SPOTIFY_OK chat=' + chatId + ' ms=' + (Date.now() - t0) + ' size=' + audioFile.size + ' title=' + meta.title);
  } catch (e) {
    console.log('SPOTIFY_FAIL chat=' + chatId + ' ms=' + (Date.now() - t0) + ' err=' + e.message);
    await fail('❌ Gagal ambil lagu Spotify. Pastikan link-nya lagu (track) Spotify yang publik, lalu coba lagi.');
  } finally {
    if (audioFile && audioFile.file) { try { fs.unlinkSync(audioFile.file); } catch (_) {} }
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
    if (isSpotifyUrl(d.url)) return handleSpotify(chatId, d.url);
    if (isVideoUrl(d.url)) return handleDownload(chatId, d.url, fmt);
    return bot.sendMessage(chatId, 'Link-nya bukan dari YouTube/TikTok/Instagram/Spotify. Coba link lain ya.');
  }
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  // 0. link Spotify -> langsung MP3 (tanpa pilih format)
  if (isSpotifyUrl(text)) {
    delete modes[chatId];
    return handleSpotify(chatId, text);
  }
  // 1. link video selalu didahulukan -> tanya format dulu (MP4/MP3)
  if (isVideoUrl(text)) {
    const want = modes[chatId];
    if (want) {
      const got = platformOf(text);
      if (got && got !== want) {
        const label = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram', spotify: 'Spotify' };
        return bot.sendMessage(chatId, 'Itu link ' + (label[got] || 'lain') + ', kamu pencet DOWNLOAD ' + want.toUpperCase() + '. Kirim link ' + (label[want] || '') + ' ya, atau pencet tombol yang sesuai.');
      }
      delete modes[chatId];
    }
    pendingDl[chatId] = { url: text };
    return bot.sendMessage(chatId, '🎵 Pilih format download:', {
      reply_markup: { inline_keyboard: [[{ text: '🎬 MP4 (video)', callback_data: 'fmt_mp4' }, { text: '🎵 MP3 (audio)', callback_data: 'fmt_mp3' }]] },
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
        if (isSpotifyUrl(d.url)) await handleSpotify(cid, d.url);
        else if (isVideoUrl(d.url)) await handleDownload(cid, d.url, fmt);
        else await bot.sendMessage(cid, 'Link-nya bukan dari YouTube/TikTok/Instagram/Spotify. Coba link lain ya.');
      } catch (e) { console.log('MINIAPP_Q_FAIL chat=' + cid + ' err=' + e.message); }
    }
  } finally {
    qBusy = false;
  }
}
setInterval(cekAntrianMiniApp, 3000);

(async () => {
  const v = await checkYtDlp();
  console.log(v ? 'yt-dlp OK: ' + v : 'yt-dlp TIDAK KETEMU — download akan gagal, install dulu (pip install yt-dlp)');
  console.log('Bot downloader jalan (polling). Owner: ' + OWNER);
})();
