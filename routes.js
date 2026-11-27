// routes.js — rantai fallback download per platform.
// Tiap platform punya daftar jalur (route) yang dicoba berurutan; kalau satu
// gagal (error/limit/timeout/bot-check), lanjut ke jalur berikutnya.
// HANYA jalur yang TERVERIFIKASI JALAN dari VM (24 Nov 2026) yang aktif.
// Jalur yang mati / tidak terverifikasi TIDAK dimasukkan — jumlah jalur per
// platform JUJUR apa adanya, bukan dipaksa genap 10.
//
// Terverifikasi jalan (24 Nov 2026):
//   YouTube: yt-dlp client android (extract + download file Shorts OK, 5,68MB
//     ffprobe OK), android+skipweb. Client web MATI kena bot-check (gagal 3/3
//     di load test 24 Nov, buang ~24 dtk) — sejak 24 Nov android JADI PERTAMA,
//     web cuma fallback (tetap ada, bisa pulih).
//   TikTok: tikwm API (code 0 + play URL bisa di-GET, mp4), yt-dlp extract +
//     download (616KB ffprobe OK), ssstik -> tikcdn (GET 200, ftyp mp4).
//     BUG NEKOGRAM 24 Nov: URL hasil extract kadang BUKAN video — yt-dlp
//     extract URL TikTok dibalas 403 HTML oleh CDN, ssstik ambil link poster
//     JPEG; bot kirim URL itu ke Telegram tanpa cek, klien gagal memutar.
//     PERBAIKAN 24 Nov: semua hasil mode URL divalidasi HEAD dulu (status
//     200 + content-type video + ukuran wajar) sebelum di-yield; ssstik
//     sekarang pilih link /v/ (video), bukan match pertama (poster).
//     downloadUrlFile juga cek magic bytes ftyp. Tikwm sendiri mentok:
//     API ~2-3 dtk, limit 1 req/detik — tidak bisa dicepetin.
//   Instagram: yt-dlp extract + download (677KB ffprobe OK). Mentok: extract
//     ~5,3 dtk di semua client (web = android = skipweb) — Instagram-bound,
//     tidak ada jalur yang lebih cepat.
//   Spotify: oEmbed meta + ytsearch (android) + unduh audio mp3 (6,4MB OK).
//     Mentok: total 18-36 dtk, variansi jaringan besar; android/web/
//     android_music tidak ada yang terbukti lebih cepat; convert mp3 cuma
//     ~4 dtk (skip convert hemat 4 dtk tapi file jadi .m4a, bukan .mp3 —
//     tidak diubah, user minta MP3). Android client cuma punya format 18
//     (video+audio 11,8MB); web/android_music punya audio-only (3,3MB)
//     tapi total waktunya sama (variansi menutupi).
//   Bilibili (27 Nov 2026, DALAM PENGUJIAN di Altare): 1 jalur file (yt-dlp
//     + merge ffmpeg, 720 dulu lalu 360 kalau >45MB; kalau 360 pun masih
//     >45MB, file dipecah jadi beberapa bagian <=45MB) + 1 jalur audio MP3.
//     Mode URL TIDAK dipakai — stream Bilibili DASH video-only + audio-only,
//     extractDirect cuma dapat video tanpa suara. Dari VM Muse ke-block geo
//     (Bstation cuma SEA), dari VMOS Hongkong lolos (format s.d. 720p).
//     Link pendek bili.im / b23.tv ikut didukung (redirect ke bilibili.tv/com).
// Mati / tidak terverifikasi (TIDAK dipakai):
//   cobalt API publik — sekarang minta JWT (error.api.auth.jwt.missing);
//     jalur ada di kode tapi NONAKTIF kecuali env COBALT_API_KEY diset.
//   Invidious (api 000, yewtu 403, nadeko 403, datura gagal), Piped
//     (piped.video HTML, mha timeout, kavin kosong), ddinstagram (000),
//     snapinsta (gagal), musicaldown (Cloudflare), tiktokio (timeout),
//     api.tikwm.com (gagal), yt-dlp client ios/tv_embedded/mweb/android_music
//     (gagal buat Shorts), IG __a=1 (404), spotifydown (endpoint tidak ketemu).
const {
  extractDirect, downloadFile, downloadBiliFile, downloadUrlFile, extractAudioInfo, downloadAudioFile,
  downloadAudioUrlFile, fetchTikwm, fetchSpotifyMeta,
  extractDirectClient, downloadFileClient, extractAudioInfoClient, downloadAudioFileClient,
  cobaltFetch, fetchSsstik, validateVideoUrl,
} = require('./downloader');
const cache = require('./cache');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Klasifikasi error — dipakai buat pesan jujur ke user + statistik.
function classifyError(e) {
  const m = String((e && e.message) || e || '');
  if (/TIKWM_LIMIT/i.test(m)) return 'LIMIT';
  if (/TOO_BIG/i.test(m)) return 'TOO_BIG';
  if (/geo restriction|not available from your location|geo-block/i.test(m)) return 'GEO';
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
    { id: 'ytdlp-android-direct', run: async (url) => { const d = await extractDirectClient(url, 'android'); return { mode: 'url', ...d }; } },
    { id: 'ytdlp-android-file', run: async (url, chatId) => { const d = await downloadFileClient(url, chatId, 'android'); return { mode: 'file', ...d, title: '' }; } },
    { id: 'ytdlp-android-skipweb-direct', run: async (url) => { const d = await extractDirectClient(url, 'android-skipweb'); return { mode: 'url', ...d }; } },
    { id: 'ytdlp-web-direct', run: async (url) => { const d = await extractDirect(url); return { mode: 'url', ...d }; } },
    { id: 'ytdlp-web-file', run: async (url, chatId) => { const d = await downloadFile(url, chatId); return { mode: 'file', ...d, title: '' }; } },
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
  // Bilibili: HANYA file (alasan di atas). 1 jalur, jujur apa adanya.
  bilibili: [
    { id: 'ytdlp-bili-file', run: async (url, chatId) => { const d = await downloadBiliFile(url, chatId); return { mode: 'file', ...d, title: '' }; } },
  ],
};

// Jalur audio (MP3). Hasil selalu file lokal.
const AUDIO_ROUTES = {
  youtube: [
    { id: 'ytdlp-android-audio', run: async (url, chatId) => { const info = await extractAudioInfoClient(url, 'android'); const f = await downloadAudioFileClient(url, chatId, null, 'android'); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
    { id: 'ytdlp-web-audio', run: async (url, chatId) => { const info = await extractAudioInfo(url); const f = await downloadAudioFile(url, chatId); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
    { id: 'cobalt-audio', gated: true, run: async (url, chatId) => { const d = await cobaltFetch(url, true); const f = await downloadAudioUrlFile(d.url, chatId, 'audio'); return { ...f, performer: '', duration: 0 }; } },
  ],
  tiktok: [
    { id: 'tikwm-music', run: async (url, chatId) => { const tk = await fetchTikwm(url); if (!tk.musicUrl) throw new Error('tikwm: tidak ada musik'); const f = await downloadAudioUrlFile(tk.musicUrl, chatId, tk.musicTitle || tk.title || 'audio'); return { ...f, performer: tk.musicAuthor || '', duration: 0 }; } },
    { id: 'ytdlp-web-audio', run: async (url, chatId) => { const info = await extractAudioInfo(url); const f = await downloadAudioFile(url, chatId); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
    { id: 'ytdlp-android-audio', run: async (url, chatId) => { const info = await extractAudioInfoClient(url, 'android'); const f = await downloadAudioFileClient(url, chatId, null, 'android'); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
  ],
  instagram: [
    { id: 'ytdlp-android-audio', run: async (url, chatId) => { const info = await extractAudioInfoClient(url, 'android'); const f = await downloadAudioFileClient(url, chatId, null, 'android'); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
    { id: 'ytdlp-web-audio', run: async (url, chatId) => { const info = await extractAudioInfo(url); const f = await downloadAudioFile(url, chatId); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
    { id: 'cobalt-audio', gated: true, run: async (url, chatId) => { const d = await cobaltFetch(url, true); const f = await downloadAudioUrlFile(d.url, chatId, 'audio'); return { ...f, performer: '', duration: 0 }; } },
  ],
  bilibili: [
    { id: 'ytdlp-bili-audio', run: async (url, chatId) => { const info = await extractAudioInfo(url); const f = await downloadAudioFile(url, chatId); return { ...f, performer: info.uploader || '', duration: info.duration || 0 }; } },
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
      // Hasil mode URL WAJIB divalidasi dulu — URL extract kadang bukan video
      // (403 HTML / thumbnail JPEG) dan Telegram akan simpan apa pun itu
      // sebagai "video" yang tidak bisa diputar (bug Nekogram 24 Nov).
      // URL tidak valid = jalur gagal, lanjut ke jalur berikutnya.
      if (res.mode === 'url' && res.url) {
        const vok = await validateVideoUrl(res.url);
        if (!vok.ok) {
          const cls2 = classifyError(new Error(vok.reason));
          failures.push({ route: r.id, error: 'URL tidak valid: ' + vok.reason, cls: cls2 });
          logRoute(r.id, platform, false, new Error('URL tidak valid: ' + vok.reason));
          continue;
        }
      }
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
