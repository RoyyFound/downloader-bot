// routes.js — rantai fallback download per platform.
// Tiap platform punya daftar jalur (route) yang dicoba berurutan; kalau satu
// gagal (error/limit/timeout/bot-check), lanjut ke jalur berikutnya.
// HANYA jalur yang TERVERIFIKASI JALAN dari VM (24 Nov 2026) yang aktif.
// Jalur yang mati / tidak terverifikasi TIDAK dimasukkan — jumlah jalur per
// platform JUJUR apa adanya, bukan dipaksa genap 10.
//
// Terverifikasi jalan (24 Nov 2026):
//   YouTube: yt-dlp client web (kadang kena bot-check), yt-dlp client android
//     (extract + download file Shorts OK, 5,68MB ffprobe OK), android+skipweb.
//   TikTok: tikwm API (code 0 + play URL bisa di-GET, mp4), yt-dlp extract +
//     download (616KB ffprobe OK), ssstik -> tikcdn (GET 200, ftyp mp4).
//   Instagram: yt-dlp extract + download (677KB ffprobe OK).
//   Spotify: oEmbed meta + ytsearch (android) + unduh audio mp3 (6,4MB OK).
// Mati / tidak terverifikasi (TIDAK dipakai):
//   cobalt API publik — sekarang minta JWT (error.api.auth.jwt.missing);
//     jalur ada di kode tapi NONAKTIF kecuali env COBALT_API_KEY diset.
//   Invidious (api 000, yewtu 403, nadeko 403, datura gagal), Piped
//     (piped.video HTML, mha timeout, kavin kosong), ddinstagram (000),
//     snapinsta (gagal), musicaldown (Cloudflare), tiktokio (timeout),
//     api.tikwm.com (gagal), yt-dlp client ios/tv_embedded/mweb/android_music
//     (gagal buat Shorts), IG __a=1 (404), spotifydown (endpoint tidak ketemu).
const {
  extractDirect, downloadFile, downloadUrlFile, extractAudioInfo, downloadAudioFile,
  downloadAudioUrlFile, fetchTikwm, fetchSpotifyMeta,
  extractDirectClient, downloadFileClient, extractAudioInfoClient, downloadAudioFileClient,
  cobaltFetch, fetchSsstik,
} = require('./downloader');
const cache = require('./cache');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Klasifikasi error — dipakai buat pesan jujur ke user + statistik.
function classifyError(e) {
  const m = String((e && e.message) || e || '');
  if (/TIKWM_LIMIT/i.test(m)) return 'LIMIT';
  if (/sign in to confirm|not a bot|bot-check|429|too many requests/i.test(m)) return 'BOTCHECK';
  if (/TIKWM_DOWN/i.test(m)) return 'DOWN';
  if (/private|privat|deleted|not found|404|unavailable|login-only|tidak ada|tidak ketemu/i.test(m)) return 'NOTFOUND';
  if (/timeout|timed out|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|aborted|aborted/i.test(m)) return 'NETWORK';
  return 'OTHER';
}

function logRoute(route, platform, ok, err) {
  console.log('ROUTE ' + (ok ? 'OK  ' : 'FAIL') + ' ' + route + ' plat=' + platform + (err ? ' err=' + String(err.message || err).slice(0, 120) : ''));
  cache.recordRoute(route, platform, ok, ok ? '' : String(err && err.message || err)).catch(() => {});
}

// Jalur video. Tiap route mengembalikan { mode: 'url'|'file', url?, file?, size, title, tooBig? }.
const VIDEO_ROUTES = {
  youtube: [
    { id: 'ytdlp-web-direct', run: async (url) => { const d = await extractDirect(url); return { mode: 'url', ...d }; } },
    { id: 'ytdlp-android-direct', run: async (url) => { const d = await extractDirectClient(url, 'android'); return { mode: 'url', ...d }; } },
    { id: 'ytdlp-android-file', run: async (url, chatId) => { const d = await downloadFileClient(url, chatId, 'android'); return { mode: 'file', ...d, title: '' }; } },
    { id: 'ytdlp-web-file', run: async (url, chatId) => { const d = await downloadFile(url, chatId); return { mode: 'file', ...d, title: '' }; } },
    { id: 'ytdlp-android-skipweb-direct', run: async (url) => { const d = await extractDirectClient(url, 'android-skipweb'); return { mode: 'url', ...d }; } },
    { id: 'cobalt-video', gated: true, run: async (url) => { const d = await cobaltFetch(url, false); return { mode: 'url', ...d }; } },
  ],
  tiktok: [
    { id: 'tikwm', run: async (url) => { const d = await fetchTikwm(url); return { mode: 'url', ...d }; } },
    { id: 'ytdlp-web-direct', run: async (url) => { const d = await extractDirect(url); return { mode: 'url', ...d }; } },
    { id: 'ytdlp-web-file', run: async (url, chatId) => { const d = await downloadFile(url, chatId); return { mode: 'file', ...d, title: '' }; } },
    { id: 'ssstik', run: async (url) => { const d = await fetchSsstik(url); return { mode: 'url', ...d }; } },
  ],
  instagram: [
    { id: 'ytdlp-web-direct', run: async (url) => { const d = await extractDirect(url); return { mode: 'url', ...d }; } },
    { id: 'ytdlp-web-file', run: async (url, chatId) => { const d = await downloadFile(url, chatId); return { mode: 'file', ...d, title: '' }; } },
    { id: 'cobalt-video', gated: true, run: async (url) => { const d = await cobaltFetch(url, false); return { mode: 'url', ...d }; } },
  ],
};

// Jalur audio (MP3). Hasil selalu file lokal.
const AUDIO_ROUTES = {
  youtube: [
    { id: 'ytdlp-web-audio', run: async (url, chatId) => { const info = await extractAudioInfo(url); const f = await downloadAudioFile(url, chatId); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
    { id: 'ytdlp-android-audio', run: async (url, chatId) => { const info = await extractAudioInfoClient(url, 'android'); const f = await downloadAudioFileClient(url, chatId, null, 'android'); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
    { id: 'cobalt-audio', gated: true, run: async (url, chatId) => { const d = await cobaltFetch(url, true); const f = await downloadAudioUrlFile(d.url, chatId, 'audio'); return { ...f, performer: '', duration: 0 }; } },
  ],
  tiktok: [
    { id: 'tikwm-music', run: async (url, chatId) => { const tk = await fetchTikwm(url); if (!tk.musicUrl) throw new Error('tikwm: tidak ada musik'); const f = await downloadAudioUrlFile(tk.musicUrl, chatId, tk.musicTitle || tk.title || 'audio'); return { ...f, performer: tk.musicAuthor || '', duration: 0 }; } },
    { id: 'ytdlp-web-audio', run: async (url, chatId) => { const info = await extractAudioInfo(url); const f = await downloadAudioFile(url, chatId); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
    { id: 'ytdlp-android-audio', run: async (url, chatId) => { const info = await extractAudioInfoClient(url, 'android'); const f = await downloadAudioFileClient(url, chatId, null, 'android'); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
  ],
  instagram: [
    { id: 'ytdlp-web-audio', run: async (url, chatId) => { const info = await extractAudioInfo(url); const f = await downloadAudioFile(url, chatId); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
    { id: 'ytdlp-android-audio', run: async (url, chatId) => { const info = await extractAudioInfoClient(url, 'android'); const f = await downloadAudioFileClient(url, chatId, null, 'android'); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
    { id: 'cobalt-audio', gated: true, run: async (url, chatId) => { const d = await cobaltFetch(url, true); const f = await downloadAudioUrlFile(d.url, chatId, 'audio'); return { ...f, performer: '', duration: 0 }; } },
  ],
};

// Spotify: meta dari oEmbed, audio dari YouTube search (android dulu, web cadangan).
const SPOTIFY_ROUTES = [
  { id: 'spotify-ytsearch-android', run: async (url, chatId, meta) => { const query = (meta.artist ? meta.artist + ' - ' : '') + meta.title; const f = await downloadAudioFileClient('ytsearch1:' + query, chatId, query, 'android'); return { ...f, performer: meta.artist || '', duration: 0 }; } },
  { id: 'spotify-ytsearch-web', run: async (url, chatId, meta) => { const query = (meta.artist ? meta.artist + ' - ' : '') + meta.title; const f = await downloadAudioFile('ytsearch1:' + query, chatId, query); return { ...f, performer: meta.artist || '', duration: 0 }; } },
];

// Generator: coba jalur berurutan, yield tiap hasil sukses. Bot yang narik
// (for await) bisa lanjut ke jalur berikut kalau kirim via URL gagal di Telegram.
async function* chain(routes, platform, url, chatId, meta) {
  const failures = [];
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    if (r.gated && !process.env.COBALT_API_KEY) {
      console.log('ROUTE SKIP ' + r.id + ' plat=' + platform + ' (COBALT_API_KEY tidak diset)');
      continue;
    }
    if (i > 0) await sleep(1200); // jeda antar jalur — hindari burst rate-limit
    try {
      const res = await r.run(url, chatId, meta);
      if (res.tooBig) throw new Error('TOO_BIG');
      logRoute(r.id, platform, true);
      yield { route: r.id, ...res };
    } catch (e) {
      const cls = e.message === 'TOO_BIG' ? 'TOO_BIG' : classifyError(e);
      failures.push({ route: r.id, error: String(e.message || e).slice(0, 200), cls });
      logRoute(r.id, platform, false, e);
      if (cls === 'TOO_BIG') throw e; // file kegedean — jalur lain juga akan kegedean, berhenti
    }
  }
  // habis semua jalur — lempar ringkasan biar bot bisa kasih pesan jujur
  const err = new Error('CHAIN_FAIL');
  err.failures = failures;
  err.cls = failures.length ? failures[failures.length - 1].cls : 'OTHER';
  throw err;
}

function videoChain(platform, url, chatId) {
  const routes = VIDEO_ROUTES[platform] || VIDEO_ROUTES.youtube;
  return chain(routes, platform, url, chatId, null);
}
function audioChain(platform, url, chatId) {
  const routes = AUDIO_ROUTES[platform] || AUDIO_ROUTES.youtube;
  return chain(routes, platform, url, chatId, null);
}
async function* spotifyChain(url, chatId) {
  const meta = await fetchSpotifyMeta(url); // gagal di sini = link Spotify salah
  yield* chain(SPOTIFY_ROUTES, 'spotify', url, chatId, meta);
  // chain() di atas throw CHAIN_FAIL kalau semua gagal — meta ikut dibawa
}
function routeCounts() {
  const out = {};
  for (const [p, rs] of Object.entries(VIDEO_ROUTES)) out[p + '/mp4'] = rs.length;
  for (const [p, rs] of Object.entries(AUDIO_ROUTES)) out[p + '/mp3'] = rs.length;
  out['spotify/mp3'] = SPOTIFY_ROUTES.length;
  return out;
}

module.exports = { videoChain, audioChain, spotifyChain, routeCounts, classifyError, VIDEO_ROUTES, AUDIO_ROUTES, SPOTIFY_ROUTES, _chainForTest: chain };
