// scripts/install-ytdlp.js — postinstall: unduh binary standalone yt-dlp (Linux)
// ke ./bin/yt-dlp biar tiap deploy Altare selalu ada yt-dlp.
//
// Kenapa perlu: Altare rebuild container dari repo tiap deploy, dan
// `npm install` tidak bawa yt-dlp — makanya bot log "yt-dlp TIDAK KETEMU"
// dan semua jalur fallback yang pakai yt-dlp mati di Altare, padahal di VM
// tes lokal jalan (yt-dlp ada di ~/workspace/ytdlp-venv).
//
// Kenapa binary standalone, bukan pip: template Node.js Altare belum tentu
// ada pip; binary dari GitHub releases lebih andal dan tidak butuh Python.
// Binary TIDAK di-commit (masuk .gitignore); download terjadi tiap kali
// `npm install` jalan. Kalau binary sudah ada, download di-skip.
//
// Gagal download = warning saja, JANGAN gagalkan install (exit 0) — kalau
// postinstall gagal, `npm install` ikut gagal dan deploy Altare batal.
// Bot tetap jalan tanpa yt-dlp, jalur non-yt-dlp masih bisa dipakai.
const fs = require('fs');
const https = require('https');
const path = require('path');

const DL_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(BIN_DIR, 'yt-dlp');
const TMP_PATH = BIN_PATH + '.tmp';
const MIN_BYTES = 1 * 1024 * 1024; // binary standalone ~3MB (rilis 2026.11.23 = 3.073.120 byte); di bawah 1MB pasti bukan binary
const TIMEOUT_MS = 120000;
const MAX_REDIRECTS = 5;

function download(target, redirects) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = https.get(target, { headers: { 'User-Agent': 'downloader-bot-postinstall' }, timeout: TIMEOUT_MS }, (res) => {
        try {
          const loc = res.headers.location;
          if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
            res.resume();
            if (redirects >= MAX_REDIRECTS) return reject(new Error('kebanyakan redirect'));
            return download(new URL(loc, target).toString(), redirects + 1).then(resolve, reject);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error('HTTP ' + res.statusCode));
          }
          const out = fs.createWriteStream(TMP_PATH);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve()));
          out.on('error', (e) => reject(e));
          res.on('error', (e) => reject(e));
        } catch (e) { reject(e); }
      });
    } catch (e) { return reject(e); }
    req.on('timeout', () => req.destroy(new Error('timeout download yt-dlp')));
    req.on('error', (e) => reject(e));
  });
}

(async () => {
  try {
    if (fs.existsSync(BIN_PATH) && fs.statSync(BIN_PATH).size > MIN_BYTES) {
      console.log('[postinstall] yt-dlp sudah ada di ./bin/yt-dlp, skip download.');
      return;
    }
    fs.mkdirSync(BIN_DIR, { recursive: true });
    console.log('[postinstall] mengunduh yt-dlp dari ' + DL_URL + ' ...');
    await download(DL_URL, 0);
    const size = fs.statSync(TMP_PATH).size;
    const head = fs.readFileSync(TMP_PATH, { encoding: 'utf8' }).slice(0, 100);
    if (size < MIN_BYTES || !head.startsWith('#!')) {
      fs.unlinkSync(TMP_PATH);
      throw new Error('file hasil download bukan binary yt-dlp (size ' + size + ')');
    }
    fs.renameSync(TMP_PATH, BIN_PATH);
    fs.chmodSync(BIN_PATH, 0o755);
    console.log('[postinstall] yt-dlp OK: ./bin/yt-dlp (' + (size / 1048576).toFixed(1) + ' MB)');
  } catch (e) {
    try { if (fs.existsSync(TMP_PATH)) fs.unlinkSync(TMP_PATH); } catch (_) {}
    console.warn('[postinstall] WARNING: gagal unduh yt-dlp: ' + e.message + ' — bot tetap jalan, jalur yt-dlp tidak aktif.');
    // exit 0 sengaja: jangan gagalkan `npm install` / deploy Altare.
  }
})();
