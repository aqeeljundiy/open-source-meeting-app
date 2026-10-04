# Open Source Meeting App: dashboard + meeting bots in one image.
# Bots are real Google Chrome windows on a virtual screen (Xvfb), with a
# PulseAudio null sink so Chrome has an audio device in the container.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg xvfb pulseaudio pulseaudio-utils fonts-liberation fonts-noto-color-emoji fonts-noto-cjk tini \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .

ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en TZ=UTC NODE_ENV=production PORT=4350 DATA_DIR=/app/data DISPLAY=:99 BOT_HEADLESS=0 CHROME_PATH=/usr/bin/google-chrome-stable
EXPOSE 4350
VOLUME /app/data
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/start.sh"]
