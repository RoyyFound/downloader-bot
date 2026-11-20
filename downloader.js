// downloader.js — ambil URL video langsung (direct link) via yt-dlp,
// plus unduh file video ke HP sebagai fallback.
// Jalur utama: link langsung dikasih ke Telegram (sendVideo by URL),
// server Telegram yang download dari CDN. Tapi URL videoplayback YouTube
// itu dikunci ke IP HP — server Telegram sering ditolak (403) walau
// linknya valid. Kalau kirim lewat URL gagal, bot unduh filenya sendiri
// di HP lalu upload ke Telegram sebagai file (jalur ini selalu bisa,
// karena HP yang download dari IP yang sama dengan extract).
// Makanya harus jalan di HP — IP VM diblokir TikTok.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const YTDLP_BIN_LOCAL = path.join(os.homedir(), '.local/bin/yt-dlp');
// yt-dlp terpasang di ~/.local/bin (bukan PATH sistem) — cari di sana dulu.
const YTDLP = process.env.YTDLP_BIN || (fs.existsSync(YTDLP_BIN_LOCAL) ? YTDLP_BIN_LOCAL : 'yt-dlp');
// Format: 18 = YouTube 360p mp4 (1 file), 22 = 720p mp4 (1 file).
// TikTok/IG: best mp4. Satu file = bisa langsung dikirim Telegram.
const FORMAT = '18/22/best[ext=mp4]/best';
// Format gabungan buat download — video+audio digabung ffmpeg jadi 1 file mp4.
// YouTube baru (terutama Shorts) sudah tidak punya format 18/22 lagi:
// video dan audio cuma ada sebagai stream DASH terpisah, jadi selector lama
// "satu file berisi video+audio" tidak menemukan apa-apa ("Requested format
// is not available"). ffmpeg tersedia di mesin ini, jadi merge jalan.
const FORMAT_DL = 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b';
const MAX_BYTES = 45 * 1024 * 1024; // batas aman di bawah limit bot Telegram 50MB

// Jaringan di VM ini kadang ngadat (proxy suka socket hang up) — yt-dlp bisa
// gagal padahal videonya publik dan sebenarnya bisa diunduh. Jadi tiap
// panggilan yt-dlp diulang sampai 3x kalau gagalnya karena timeout/jaringan,
// jeda 2 detik antar percobaan. Gagal karena videonya privat/dihapus tidak
// diulang — langsung lempar error biar bot jawab gagal.
function execYtDlp(args, timeoutMs, tries) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const coba = () => {
      attempt++;
      execFile(YTDLP, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (!err) return resolve(stdout);
        const msg = String((err && err.message) || '');
        const kenaJaringan = err.killed || /timed out|timeout|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(msg);
        if (kenaJaringan && attempt < tries) {
          console.log('YTDLP_RETRY attempt=' + attempt + ' err=' + msg.slice(0, 100));
          return setTimeout(coba, 2000);
        }
        reject(err);
      });
    };
    coba();
  });
}

function extractDirect(url) {
  const args = ['--dump-json', '--no-playlist', '-f', FORMAT, '--socket-timeout', '30', '--no-warnings', url];
  return execYtDlp(args, 30000, 3).then((stdout) => {
    let j;
    try { j = JSON.parse(stdout); } catch (e) { throw new Error('extract gagal: respon yt-dlp tidak bisa dibaca'); }
    const direct = j.url;
    if (!direct) throw new Error('extract gagal: tidak ada URL langsung');
    const size = j.filesize || j.filesize_approx || 0;
    return { url: direct, size, title: j.title || '', tooBig: size > MAX_BYTES };
  }).catch((err) => {
    if (err.message && err.message.startsWith('extract gagal')) throw err;
    throw new Error('extract gagal: ' + (err.killed ? 'timeout' : (err.message || 'yt-dlp error')));
  });
}

function downloadFile(url, chatId) {
  const dir = path.join(__dirname, 'tmp_dl', String(chatId));
  fs.mkdirSync(dir, { recursive: true });
  const outTpl = path.join(dir, 'dl.%(ext)s');
  const args = ['--no-playlist', '-f', FORMAT_DL, '--merge-output-format', 'mp4', '--socket-timeout', '30', '-o', outTpl, '--no-warnings', url];
  return execYtDlp(args, 90000, 3).then(() => {
    // hasil merge selalu dl.mp4 — dahulukan itu, jangan sampai kepilih
    // sisa file setengah jalan (dl.fdash-*) dari percobaan yang gagal.
    const all = fs.readdirSync(dir).filter((f) => f.startsWith('dl.'));
    const files = all.filter((f) => f.endsWith('.mp4')).concat(all.filter((f) => !f.endsWith('.mp4')));
    if (!files.length) throw new Error('download gagal: file tidak ketemu');
    const file = path.join(dir, files[0]);
    const size = fs.statSync(file).size;
    return { file, size };
  }).catch((err) => {
    if (err.message && err.message.startsWith('download gagal')) throw err;
    throw new Error('download gagal: ' + (err.killed ? 'timeout' : (err.message || 'yt-dlp error')));
  });
}

// Unduh file video langsung dari URL (pakai curl) — buat link CDN hasil
// tikwm, yang tidak bisa diunduh yt-dlp dengan selector format biasa.
function downloadUrlFile(url, chatId) {
  return new Promise((resolve, reject) => {
    const dir = path.join(__dirname, 'tmp_dl', String(chatId));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'dl.mp4');
    const args = ['-sL', '--max-time', '90', '-A', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', '-o', file, url];
    execFile('curl', args, { timeout: 95000 }, (err) => {
      if (err) return reject(new Error('download gagal: ' + (err.message || 'curl error')));
      if (!fs.existsSync(file)) return reject(new Error('download gagal: file tidak ketemu'));
      const size = fs.statSync(file).size;
      if (size < 10000) return reject(new Error('download gagal: file terlalu kecil (' + size + ' byte)'));
      resolve({ file, size });
    });
  });
}

// --- MP3 (audio saja) ---
// Info audio dulu (judul, channel, durasi) — dipakai buat nama file + judul
// lagu yang tampil di Telegram, bukan "audio.mp3".
function extractAudioInfo(url) {
  const args = ['--dump-json', '--no-playlist', '-f', 'bestaudio', '--socket-timeout', '30', '--no-warnings', url];
  return execYtDlp(args, 30000, 3).then((stdout) => {
    let j;
    try { j = JSON.parse(stdout); } catch (e) { throw new Error('info audio gagal: respon yt-dlp tidak bisa dibaca'); }
    const size = j.filesize || j.filesize_approx || 0;
    return { title: j.title || '', uploader: j.uploader || j.channel || '', duration: j.duration || 0, size, tooBig: size > MAX_BYTES };
  }).catch((err) => {
    if (err.message && err.message.startsWith('info audio gagal')) throw err;
    throw new Error('info audio gagal: ' + (err.killed ? 'timeout' : (err.message || 'yt-dlp error')));
  });
}

// Bersihkan judul biar aman jadi nama file (buang karakter terlarang).
function sanitizeTitle(t) {
  const s = String(t || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
  return (s || 'audio').slice(0, 100);
}

// yt-dlp -x: unduh audio terbaik lalu ffmpeg ubah ke mp3.
// Nama file = judul video, metadata judul ikut nempel di file (--embed-metadata).
// Kalau fixedName diisi, nama file ikut fixedName (dipakai Spotify: judul lagu
// dari Spotify, bukan judul video YouTube).
function downloadAudioFile(url, chatId, fixedName) {
  return new Promise((resolve, reject) => {
    const dir = path.join(__dirname, 'tmp_dl', String(chatId));
    fs.mkdirSync(dir, { recursive: true });
    const outTpl = fixedName
      ? path.join(dir, sanitizeTitle(fixedName) + '.%(ext)s')
      : path.join(dir, '%(title)s.%(ext)s');
    const args = ['--no-playlist', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-metadata', '--socket-timeout', '30', '-o', outTpl, '--no-warnings', url];
    execYtDlp(args, 120000, 3).then(() => {
      const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3'));
      if (!files.length) return reject(new Error('download audio gagal: file tidak ketemu'));
      const file = path.join(dir, files[0]);
      const size = fs.statSync(file).size;
      const title = files[0].replace(/\.mp3$/i, '');
      resolve({ file, size, title });
    }).catch((err) => {
      if (err.message && err.message.startsWith('download audio gagal')) return reject(err);
      reject(new Error('download audio gagal: ' + (err.killed ? 'timeout' : (err.message || 'yt-dlp error'))));
    });
  });
}

// Unduh file audio langsung dari URL (pakai curl) — buat link musik tikwm,
// yang sudah mp3 dan tidak butuh ffmpeg. Nama file = judul (dibersihkan).
function downloadAudioUrlFile(url, chatId, title) {
  return new Promise((resolve, reject) => {
    const dir = path.join(__dirname, 'tmp_dl', String(chatId));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, sanitizeTitle(title) + '.mp3');
    const args = ['-sL', '--max-time', '90', '-A', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', '-o', file, url];
    execFile('curl', args, { timeout: 95000 }, (err) => {
      if (err) return reject(new Error('download audio gagal: ' + (err.message || 'curl error')));
      if (!fs.existsSync(file)) return reject(new Error('download audio gagal: file tidak ketemu'));
      const size = fs.statSync(file).size;
      if (size < 10000) return reject(new Error('download audio gagal: file terlalu kecil (' + size + ' byte)'));
      resolve({ file, size });
    });
  });
}

// TikTok: yt-dlp sering gagal extract (IP HP diblokir TikTok / struktur
// halaman berubah). Fallback: API publik tikwm.com — server mereka yang
// ambil datanya, kita tinggal pakai link videonya (tiktokcdn, tanpa WM).
// API ini gratis, tanpa kunci, tanpa login.
async function fetchTikwm(tiktokUrl) {
  const api = 'https://tikwm.com/api/?url=' + encodeURIComponent(tiktokUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(api, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('tikwm HTTP ' + res.status);
    const j = await res.json();
    if (j.code !== 0 || !j.data || !j.data.play) throw new Error('tikwm: ' + (j.msg || 'tidak ada link video'));
    const d = j.data;
    const size = d.size || 0;
    // musik latar video (mp3 langsung) — buat tombol MP3.
    const musicUrl = (typeof d.music === 'string' ? d.music : '') || (d.music_info && d.music_info.play) || '';
    const musicTitle = (d.music_info && d.music_info.title) || '';
    const musicAuthor = (d.music_info && d.music_info.author) || '';
    return { url: d.play, size, title: d.title || '', tooBig: size > MAX_BYTES, via: 'tikwm', musicUrl, musicTitle, musicAuthor };
  } finally {
    clearTimeout(timer);
  }
}

// --- Spotify (lagu saja, audio) ---
// Spotify mengunci file lagunya (DRM) — tidak bisa diunduh langsung.
// Jalurnya: ambil judul + artis lewat oEmbed resmi Spotify (gratis, tanpa
// login), lalu cari lagu yang sama di YouTube pakai yt-dlp dan unduh
// audionya jadi MP3. Nama file + judul lagu ikut data Spotify, bukan
// judul video YouTube.
function isSpotifyUrl(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  return /open\.spotify\.com\/track\/[A-Za-z0-9]+/i.test(t) || /^spotify:track:[A-Za-z0-9]+/i.test(t);
}

function spotifyTrackId(text) {
  const t = String(text || '').trim();
  let m = t.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/i);
  if (m) return m[1];
  m = t.match(/^spotify:track:([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

async function fetchSpotifyMeta(text) {
  const id = spotifyTrackId(text);
  if (!id) throw new Error('bukan link lagu Spotify');
  const api = 'https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/track/' + id);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(api, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('spotify oEmbed HTTP ' + res.status);
    const j = await res.json();
    const title = (j.title || '').trim();
    if (!title) throw new Error('spotify: judul tidak ketemu');
    // oEmbed tidak kasih nama artis — ambil dari halaman embed
    // (ada JSON: "title":"...","artists":[{"name":"..."}]).
    let artist = '';
    try {
      const res2 = await fetch('https://open.spotify.com/embed/track/' + id, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (res2.ok) {
        const html = await res2.text();
        const m = html.match(/"artists":\[\{"name":"((?:[^"\\]|\\.)*)"/);
        if (m) artist = JSON.parse('"' + m[1] + '"');
      }
    } catch (_) { /* artis kosong — pencarian tetap jalan pakai judul saja */ }
    return { title, artist, trackId: id };
  } finally {
    clearTimeout(timer);
  }
}

function checkYtDlp() {
  return new Promise((resolve) => {
    execFile(YTDLP, ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout || '').trim());
    });
  });
}

function isVideoUrl(text) {
  if (!text || typeof text !== 'string') return false;
  return /(tiktok\.com|vt\.tiktok\.com|youtube\.com|youtu\.be|instagram\.com)\/\S+/i.test(text.trim());
}

function platformOf(text) {
  if (!text || typeof text !== 'string') return null;
  if (/tiktok\.com|vt\.tiktok\.com/i.test(text)) return 'tiktok';
  if (/youtube\.com|youtu\.be/i.test(text)) return 'youtube';
  if (/instagram\.com/i.test(text)) return 'instagram';
  return null;
}

module.exports = { extractDirect, downloadFile, downloadUrlFile, extractAudioInfo, downloadAudioFile, downloadAudioUrlFile, fetchTikwm, fetchSpotifyMeta, isSpotifyUrl, checkYtDlp, isVideoUrl, platformOf, MAX_BYTES };
