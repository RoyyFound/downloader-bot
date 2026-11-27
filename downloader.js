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

const YTDLP_BIN_PROJECT = path.join(__dirname, 'bin', 'yt-dlp');
const YTDLP_BIN_LOCAL = path.join(os.homedir(), '.local/bin/yt-dlp');
// Urutan cari yt-dlp: env YTDLP_BIN → ./bin/yt-dlp (diunduh postinstall,
// ini yang jalan di Altare) → ~/.local/bin/yt-dlp → 'yt-dlp' di PATH.
const YTDLP = process.env.YTDLP_BIN
  || (fs.existsSync(YTDLP_BIN_PROJECT) ? YTDLP_BIN_PROJECT : null)
  || (fs.existsSync(YTDLP_BIN_LOCAL) ? YTDLP_BIN_LOCAL : null)
  || 'yt-dlp';
// Format: 18 = YouTube 360p mp4 (1 file), 22 = 720p mp4 (1 file).
// TikTok/IG: best mp4. Satu file = bisa langsung dikirim Telegram.
const FORMAT = '18/22/best[ext=mp4]/best';
// Format gabungan buat download — video+audio digabung ffmpeg jadi 1 file mp4.
// YouTube baru (terutama Shorts) sudah tidak punya format 18/22 lagi:
// video dan audio cuma ada sebagai stream DASH terpisah, jadi selector lama
// "satu file berisi video+audio" tidak menemukan apa-apa ("Requested format
// is not available"). ffmpeg tersedia di mesin ini, jadi merge jalan.
const FORMAT_DL = 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b';
// Bilibili (Bstation bilibili.tv + bilibili.com): stream DASH video-only +
// audio-only, TIDAK ada format progresif — mode URL (extractDirect) cuma
// dapat video tanpa suara, jadi Bilibili HANYA lewat download file + merge.
// 720p satu episode ~140MB > batas 45MB bot, jadi coba 720 dulu, kalau
// hasil >45MB hapus lalu ulangi di 360p (hevc, ~32MB + audio muat).
const FORMAT_DL_BILI_720 = 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/bv*[height<=720]+ba/b[height<=720]/b';
const FORMAT_DL_BILI_360 = 'bv*[height<=360][vcodec*=hev][ext=mp4]+ba[ext=m4a]/bv*[height<=360][vcodec*=hev]+ba/bv*[height<=360][ext=mp4]+ba[ext=m4a]/bv*[height<=360]+ba/b[height<=360]/b';
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

// Pecah satu file video jadi beberapa bagian (target ~32MB per bagian,
// di bawah batas 45MB bot) pakai ffmpeg tanpa re-encode (copy) — cepat.
// Dipakai Bilibili kalau 360p pun masih kegedean. Kembalikan array path.
function splitFile(file, chatId) {
  const dir = path.dirname(file);
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error('split gagal: ffprobe ' + (err.message || 'error')));
      const dur = parseFloat(String(stdout || '').trim());
      if (!dur || dur <= 0) return reject(new Error('split gagal: durasi tidak kebaca'));
      const size = fs.statSync(file).size;
      const parts = Math.ceil(size / (32 * 1024 * 1024));
      if (parts <= 1) return resolve([file]);
      const segTime = Math.max(10, Math.ceil(dur / parts));
      const outTpl = path.join(dir, 'part%02d.mp4');
      execFile('ffmpeg', ['-y', '-i', file, '-c', 'copy', '-map', '0', '-f', 'segment', '-segment_time', String(segTime), '-reset_timestamps', '1', outTpl], { timeout: 180000 }, (err2) => {
        if (err2) return reject(new Error('split gagal: ffmpeg ' + (err2.message || 'error')));
        const all = fs.readdirSync(dir).filter((f) => f.startsWith('part') && f.endsWith('.mp4')).sort();
        if (!all.length) return reject(new Error('split gagal: tidak ada bagian'));
        const files = all.map((f) => path.join(dir, f));
        for (const f of files) { if (fs.statSync(f).size > MAX_BYTES) return reject(new Error('TOO_BIG: satu bagian masih >45MB')); }
        try { fs.unlinkSync(file); } catch (_) {}
        resolve(files);
      });
    });
  });
}

// ---------- Bilibili: download file + merge, 720 dulu lalu 360 kalau kegedean ----------
function downloadBiliFile(url, chatId) {
  const dir = path.join(__dirname, 'tmp_dl', String(chatId));
  fs.mkdirSync(dir, { recursive: true });
  const outTpl = path.join(dir, 'dl.%(ext)s');
  // bersihkan sisa percobaan sebelumnya di folder chat ini
  try { for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('dl.') || x.startsWith('part'))) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} } } catch (_) {}
  const formats = [FORMAT_DL_BILI_720, FORMAT_DL_BILI_360];
  const coba = (i) => {
    if (i >= formats.length) return Promise.reject(new Error('TOO_BIG: file kegedean (>45MB) bahkan di 360p'));
    const args = ['--no-playlist', '-f', formats[i], '--merge-output-format', 'mp4', '--socket-timeout', '30', '-o', outTpl, '--no-warnings', url];
    return execYtDlp(args, 120000, 2).then(() => {
      const all = fs.readdirSync(dir).filter((f) => f.startsWith('dl.'));
      const files = all.filter((f) => f.endsWith('.mp4')).concat(all.filter((f) => !f.endsWith('.mp4')));
      if (!files.length) throw new Error('download gagal: file tidak ketemu');
      const file = path.join(dir, files[0]);
      const size = fs.statSync(file).size;
      if (size > MAX_BYTES) {
        if (i + 1 < formats.length) {
          try { fs.unlinkSync(file); } catch (_) {}
          console.log('BILI_TOO_BIG coba=' + i + ' size=' + size + ' — turun resolusi');
          return coba(i + 1);
        }
        // mentok di 360p tapi masih kegedean — pecah jadi beberapa bagian
        console.log('BILI_SPLIT size=' + size);
        return splitFile(file, chatId).then((parts) => ({ files: parts, size }));
      }
      return { file, size };
    });
  };
  return coba(0).catch((err) => {
    if (err.message && (err.message.startsWith('download gagal') || err.message.startsWith('TOO_BIG'))) throw err;
    throw new Error('download gagal: ' + (err.killed ? 'timeout' : (err.message || 'yt-dlp error')));
  });
}

// ---------- validasi URL video SEBELUM dikirim ke Telegram ----------
// Bug Nekogram 24 Nov: URL hasil extract kadang BUKAN video — yt-dlp
// extract URL TikTok yang dibalas 403 HTML oleh CDN, ssstik ambil link
// thumbnail JPEG. Telegram tidak memvalidasi konten saat sendVideo by URL:
// dia simpan apa pun yang diunduh, lalu klien gagal memutarnya ("App was
// unable to play this video"). Validasi murah: 1 HEAD request — status 200,
// content-type video (atau octet-stream), ukuran wajar. Gagal validasi =
// jalur dianggap gagal, rantai lanjut ke jalur berikutnya.
async function validateVideoUrl(url) {
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      res = await fetch(url, {
        method: 'HEAD', signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' },
      });
    } finally { clearTimeout(timer); }
  } catch (e) {
    return { ok: false, reason: 'validasi gagal: ' + (e.message || 'jaringan') };
  }
  if (!res.ok) return { ok: false, reason: 'URL video HTTP ' + res.status };
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct && (ct.startsWith('text/') || ct.startsWith('image/') || ct.includes('json') || ct.includes('xml'))) {
    return { ok: false, reason: 'URL video bukan video (content-type: ' + ct + ')' };
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len < 10000) return { ok: false, reason: 'URL video terlalu kecil (' + len + ' byte)' };
  return { ok: true };
}

// Unduh file video langsung dari URL (pakai curl) — buat link CDN hasil
// tikwm, yang tidak bisa diunduh yt-dlp dengan selector format biasa.
function downloadUrlFile(url, chatId) {
  const safeUrl = validateCdnUrl(url);
  return new Promise((resolve, reject) => {
    const dir = path.join(__dirname, 'tmp_dl', String(chatId));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'dl.mp4');
    const args = ['-sL', '--max-time', '90', '-A', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', '-o', file, safeUrl];
    execFile('curl', args, { timeout: 95000 }, (err) => {
      if (err) return reject(new Error('download gagal: ' + (err.message || 'curl error')));
      if (!fs.existsSync(file)) return reject(new Error('download gagal: file tidak ketemu'));
      const size = fs.statSync(file).size;
      if (size < 10000) return reject(new Error('download gagal: file terlalu kecil (' + size + ' byte)'));
      // Cek magic bytes mp4 (ftyp di offset 4) — cegah halaman error HTML /
      // gambar JPEG kesimpen sebagai .mp4 (bug Nekogram 24 Nov).
      const head = fs.readFileSync(file).slice(0, 12);
      if (head.length < 12 || head.toString('ascii', 4, 8) !== 'ftyp') {
        try { fs.unlinkSync(file); } catch (_) {}
        return reject(new Error('download gagal: file bukan video mp4'));
      }
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
  const safeUrl = validateCdnUrl(url);
  return new Promise((resolve, reject) => {
    const dir = path.join(__dirname, 'tmp_dl', String(chatId));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, sanitizeTitle(title) + '.mp3');
    const args = ['-sL', '--max-time', '90', '-A', 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', '-o', file, safeUrl];
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
    let res;
    try {
      res = await fetch(api, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    } catch (e) {
      // Jaringan ke tikwm gagal (timeout / putus) — servernya lagi down.
      throw new Error('TIKWM_DOWN: ' + (e.message || 'jaringan gagal'));
    }
    if (!res.ok) throw new Error('TIKWM_DOWN: tikwm HTTP ' + res.status);
    const j = await res.json();
    if (j.code !== 0 || !j.data || !j.data.play) {
      const msg = j.msg || 'tidak ada link video';
      // Limit harian gratis tikwm (10.000 req/hari, dipake bareng semua orang)
      // habis — tandai khusus biar pesan ke user beda dari "video privat".
      if (/limit/i.test(msg)) throw new Error('TIKWM_LIMIT: ' + msg);
      throw new Error('tikwm: ' + msg);
    }
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
  return /(tiktok\.com|vt\.tiktok\.com|youtube\.com|youtu\.be|instagram\.com|bilibili\.tv|bilibili\.com|bili\.im|b23\.tv)\/\S+/i.test(text.trim());
}

function platformOf(text) {
  if (!text || typeof text !== 'string') return null;
  if (/tiktok\.com|vt\.tiktok\.com/i.test(text)) return 'tiktok';
  if (/youtube\.com|youtu\.be/i.test(text)) return 'youtube';
  if (/instagram\.com/i.test(text)) return 'instagram';
  if (/bilibili\.tv|bilibili\.com/i.test(text)) return 'bilibili';
  if (/bili\.im|b23\.tv/i.test(text)) return 'bilibili';
  return null;
}

// ---------- keamanan: validasi URL + path ----------
// Hanya host ini yang boleh diunduh. Regex lama (isVideoUrl) tidak di-anchor
// — link seperti https://jahat.com/?x=youtube.com/... lolos. Sekarang cek
// hostname hasil parse URL, tolak userinfo (@) dan host privat/reserved
// (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, ::1, 169.254.x) —
// cegah bot dipakai buat nyerang layanan internal (SSRF).
const ALLOWED_HOSTS = new Set([
  'tiktok.com', 'www.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com',
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
  'music.youtube.com',
  'instagram.com', 'www.instagram.com',
  'bilibili.tv', 'www.bilibili.tv', 'bilibili.com', 'www.bilibili.com', 'm.bilibili.com',
  'bili.im', 'b23.tv',
  'open.spotify.com',
]);
function isPrivateIp(host) {
  if (!host) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^0\.0\.0\.0$/.test(h) || /^::/.test(h)) return true;
  return false;
}
// Kembalikan { ok, platform, reason }. platform: tiktok|youtube|instagram|spotify|null.
function validateMediaUrl(text) {
  if (!text || typeof text !== 'string') return { ok: false, reason: 'link kosong' };
  let u;
  try { u = new URL(text.trim()); } catch (_) { return { ok: false, reason: 'link tidak valid' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'protokol tidak didukung' };
  if (u.username || u.password) return { ok: false, reason: 'link mengandung kredensial' };
  const host = u.hostname.toLowerCase();
  if (isPrivateIp(host)) return { ok: false, reason: 'host privat/dilarang' };
  if (!ALLOWED_HOSTS.has(host)) return { ok: false, reason: 'domain tidak didukung' };
  let platform = null;
  if (/tiktok\.com$/.test(host)) platform = 'tiktok';
  else if (/youtube\.com$/.test(host) || host === 'youtu.be') platform = 'youtube';
  else if (/instagram\.com$/.test(host)) platform = 'instagram';
  else if (/bilibili\.(tv|com)$/.test(host)) platform = 'bilibili';
  else if (host === 'bili.im' || host === 'b23.tv') platform = 'bilibili';
  else if (host === 'open.spotify.com') platform = 'spotify';
  return { ok: true, platform, url: u.toString() };
}
// Gabung path tapi pastikan hasil akhirnya tetap di dalam dir (anti ../).
function safeJoin(dir, name) {
  const resolved = path.resolve(dir, String(name));
  const base = path.resolve(dir) + path.sep;
  if (resolved !== path.resolve(dir) && !resolved.startsWith(base)) throw new Error('nama file tidak aman');
  return resolved;
}

// ---------- varian client yt-dlp (jalur fallback YouTube) ----------
// Client default YouTube sering kena bot-check (429 / "Sign in to confirm
// you're not a bot") dari IP datacenter. Client android lolos lebih sering
// (terverifikasi 24 Nov: extract + download Shorts jalan). Tiap client =
// jalur fallback yang berbeda.
function ytdlpArgsBase(extraExtractorArgs) {
  const args = [];
  if (extraExtractorArgs) args.push('--extractor-args', extraExtractorArgs);
  return args;
}
function extractDirectClient(url, client) {
  const extra = client === 'android' ? 'youtube:player_client=android'
    : client === 'android-skipweb' ? 'youtube:player_client=android;player_skip=webpage'
    : null;
  const args = [...ytdlpArgsBase(extra), '--dump-json', '--no-playlist', '-f', FORMAT, '--socket-timeout', '30', '--no-warnings', url];
  return execYtDlp(args, 30000, 2).then((stdout) => {
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
function downloadFileClient(url, chatId, client) {
  const dir = path.join(__dirname, 'tmp_dl', String(chatId));
  fs.mkdirSync(dir, { recursive: true });
  const outTpl = path.join(dir, 'dl.%(ext)s');
  const extra = client === 'android' ? 'youtube:player_client=android' : null;
  const args = [...ytdlpArgsBase(extra), '--no-playlist', '-f', FORMAT_DL, '--merge-output-format', 'mp4', '--socket-timeout', '30', '-o', outTpl, '--no-warnings', url];
  return execYtDlp(args, 120000, 2).then(() => {
    const all = fs.readdirSync(dir).filter((f) => f.startsWith('dl.'));
    const files = all.filter((f) => f.endsWith('.mp4')).concat(all.filter((f) => !f.endsWith('.mp4')));
    if (!files.length) throw new Error('download gagal: file tidak ketemu');
    const file = safeJoin(dir, files[0]);
    const size = fs.statSync(file).size;
    return { file, size };
  }).catch((err) => {
    if (err.message && err.message.startsWith('download gagal')) throw err;
    throw new Error('download gagal: ' + (err.killed ? 'timeout' : (err.message || 'yt-dlp error')));
  });
}
function extractAudioInfoClient(url, client) {
  const extra = client === 'android' ? 'youtube:player_client=android' : null;
  const fmt = client === 'android' ? 'bestaudio/best' : 'bestaudio';
  const args = [...ytdlpArgsBase(extra), '--dump-json', '--no-playlist', '-f', fmt, '--socket-timeout', '30', '--no-warnings', url];
  return execYtDlp(args, 30000, 2).then((stdout) => {
    let j;
    try { j = JSON.parse(stdout); } catch (e) { throw new Error('info audio gagal: respon yt-dlp tidak bisa dibaca'); }
    const size = j.filesize || j.filesize_approx || 0;
    return { title: j.title || '', uploader: j.uploader || j.channel || '', duration: j.duration || 0, size, tooBig: size > MAX_BYTES, url: j.url || '' };
  }).catch((err) => {
    if (err.message && err.message.startsWith('info audio gagal')) throw err;
    throw new Error('info audio gagal: ' + (err.killed ? 'timeout' : (err.message || 'yt-dlp error')));
  });
}
function downloadAudioFileClient(url, chatId, fixedName, client) {
  return new Promise((resolve, reject) => {
    const dir = path.join(__dirname, 'tmp_dl', String(chatId));
    fs.mkdirSync(dir, { recursive: true });
    const outTpl = fixedName
      ? path.join(dir, sanitizeTitle(fixedName) + '.%(ext)s')
      : path.join(dir, '%(title)s.%(ext)s');
    const extra = client === 'android' ? 'youtube:player_client=android' : null;
    const args = [...ytdlpArgsBase(extra), '--no-playlist', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-metadata', '--socket-timeout', '30', '-f', 'bestaudio/best', '-o', outTpl, '--no-warnings', url];
    execYtDlp(args, 120000, 2).then(() => {
      const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3'));
      if (!files.length) return reject(new Error('download audio gagal: file tidak ketemu'));
      const file = safeJoin(dir, files[0]);
      const size = fs.statSync(file).size;
      const title = files[0].replace(/\.mp3$/i, '');
      resolve({ file, size, title });
    }).catch((err) => {
      if (err.message && err.message.startsWith('download audio gagal')) return reject(err);
      reject(new Error('download audio gagal: ' + (err.killed ? 'timeout' : (err.message || 'yt-dlp error'))));
    });
  });
}

// ---------- cobalt (jalur fallback, BUTUH API KEY) ----------
// API publik cobalt sekarang minta JWT (error.api.auth.jwt.missing tanpa
// key). Jalur ini AKTIF hanya kalau env COBALT_API_KEY diset — tanpa key,
// jalur dilewati (bukan error). Key jangan pernah di-commit.
async function cobaltFetch(url, isAudio) {
  const key = process.env.COBALT_API_KEY || '';
  if (!key) throw new Error('COBALT_NO_KEY');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch('https://api.cobalt.tools/', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': 'Api-Key ' + key },
      body: JSON.stringify(isAudio
        ? { url, aFormat: 'mp3', filenamePattern: 'basic' }
        : { url, vCodec: 'h264', vQuality: '720', filenamePattern: 'basic' }),
    });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'stream' || j.status === 'redirect') {
      if (!j.url) throw new Error('cobalt: tidak ada link');
      return { url: j.url, title: '', size: 0, tooBig: false, via: 'cobalt' };
    }
    throw new Error('cobalt: ' + ((j.error && j.error.code) || j.status || ('HTTP ' + res.status)));
  } finally { clearTimeout(timer); }
}

// ---------- ssstik (jalur fallback TikTok) ----------
// POST form ke ssstik.io, ambil link tikcdn.io dari HTML hasil.
// Terverifikasi 24 Nov: link tikcdn bisa diunduh (GET 200, ftyp mp4).
async function fetchSsstik(tiktokUrl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch('https://ssstik.io/abc?url=dl', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' },
      body: 'id=' + encodeURIComponent(tiktokUrl) + '&locale=en&tt=0',
    });
    if (!res.ok) throw new Error('ssstik HTTP ' + res.status);
    const html = await res.text();
    if (/cloudflare|attention required|just a moment/i.test(html)) throw new Error('ssstik kena Cloudflare');
    const all = html.match(/https?:\/\/tikcdn\.io\/ssstik\/[^\s"'<>]+/g) || [];
    // Pilih link VIDEO: /v/ dulu, lalu /ssstik/<id> polos. Regex lama ambil
    // match pertama — itu poster JPEG (/p/) (bug Nekogram 24 Nov: "video"
    // yang dikirim ternyata gambar 240x320). /p/ = poster, /a/ = avatar,
    // /m/ = musik — ketiganya BUKAN video.
    const pick = all.find((u) => /\/ssstik\/v\//.test(u))
      || all.find((u) => /\/ssstik\/\d+\?/.test(u))
      || all.find((u) => !/\/(p|a|m)\//.test(u));
    if (!pick) throw new Error('ssstik: link video tidak ketemu');
    return { url: pick, size: 0, title: '', tooBig: false, via: 'ssstik' };
  } finally { clearTimeout(timer); }
}

// Unduh file dari URL CDN — validasi dulu (hanya http/https, host bukan privat).
function validateCdnUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch (_) { throw new Error('URL CDN tidak valid'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL CDN tidak valid');
  if (isPrivateIp(u.hostname)) throw new Error('URL CDN host privat/dilarang');
  return u.toString();
}

module.exports = { extractDirect, downloadFile, downloadBiliFile, splitFile, downloadUrlFile, extractAudioInfo, downloadAudioFile, downloadAudioUrlFile, fetchTikwm, fetchSpotifyMeta, isSpotifyUrl, checkYtDlp, isVideoUrl, platformOf, MAX_BYTES, validateMediaUrl, safeJoin, extractDirectClient, downloadFileClient, extractAudioInfoClient, downloadAudioFileClient, cobaltFetch, fetchSsstik, validateCdnUrl, validateVideoUrl, YTDLP_BIN: YTDLP };
