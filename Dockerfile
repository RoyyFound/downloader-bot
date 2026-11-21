# Bot Telegram Downloader — jalan di Altare (Bot Hosting)
FROM node:20-slim

# yt-dlp (via pip) buat YouTube/Spotify + ffmpeg buat gabung/convert
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# npm install (bukan npm ci — npm ci pernah gagal di Altare)
RUN npm install --omit=dev

COPY bot.js downloader.js ./

# yt-dlp ada di PATH (/usr/local/bin/yt-dlp), ffmpeg juga di PATH
ENV YTDLP_BIN=yt-dlp
ENV NODE_ENV=production

CMD ["node", "bot.js"]
