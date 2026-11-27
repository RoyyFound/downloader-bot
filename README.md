# Downloader Bot — Telegram

Bot Telegram gratis buat download video TikTok, YouTube, Instagram, dan lagu Spotify (jadi MP3). Kirim link, videonya kekirim. Jalan pakai polling, jadi ga butuh webhook atau domain.

## Jalankan di Altare (Bot Hosting)

1. Di console Altare, pencet **Create app** → pilih **Bot Hosting**.
2. Pilih repo ini (`RoyyFound/downloader-bot`).
3. Isi environment variable:
   - `BOT_TOKEN` — token bot dari BotFather
   - `OWNER_CHAT_ID` — chat id owner (buat perintah `/stats`)
4. Deploy. Altare build Docker image-nya (Node + yt-dlp + ffmpeg) lalu jalanin `node bot.js`.

## Jalankan lokal

```bash
npm install
cp .env.example .env   # isi BOT_TOKEN di sini
node bot.js
```

Isi `.env`:

```
BOT_TOKEN=isi_token_bot_kamu
OWNER_CHAT_ID=isi_chat_id_kamu
```

## Catatan

- Token JANGAN pernah di-commit ke repo. `.env` sudah ada di `.gitignore`.
- `users.json` dan `stats.json` dibuat otomatis pas bot jalan (data lokal, ga ikut ke-push).
- Kalau bot dipindah dari tempat lama ke sini, matikan dulu bot yang lama — dua bot polling pakai token yang sama bakal rebutan dan jadi error.

## WhatsApp (Baileys) — TEST
Env tambahan: `WA_NUMBER` (nomor bot WA tanpa '+', contoh `6281234567890`). Kalau kosong, WA mati, Telegram tetap jalan.
Pairing: saat startup (selama belum terdaftar) bot minta pairing code lalu kirim kodenya ke owner lewat DM Telegram; atau kirim `/pairwa` di Telegram (owner saja) untuk minta kode baru kapan pun. Masukkan kode di WA: Pengaturan → Perangkat Tertaut → Tautkan Perangkat → "Tautkan dengan nomor telepon".
Sesi di `wa-auth/` (gitignore) — INI yang dites: apakah Altare menyimpan file ini antar deploy. Kalau tiap deploy WA minta pairing ulang, berarti Altare tidak menyimpan file → WA harus jalan di tempat lain (VSPhone, seperti bot confes).
Risiko: Baileys tidak resmi — nomor bisa ke-ban; pakai nomor cadangan, bukan nomor utama.
Perintah WA: kirim link langsung (MP4 default, tambah kata "mp3" untuk audio), `/start` untuk panduan.
