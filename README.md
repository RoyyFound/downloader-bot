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
