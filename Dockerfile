# Bookmark Studio — the local server in a container, with Chromium for headless previews.
#
#   docker build -t bookmark-studio .
#   docker run --rm -p 127.0.0.1:5174:5174 bookmark-studio
#
# Then open http://127.0.0.1:5174. Publishing the port on 127.0.0.1 only (as above) keeps the
# server's page-fetching API off your network. See SECURITY.md before exposing it more widely.
# Reaching it by another name (a LAN address or your own domain)? Add -e ALLOWED_HOSTS=name:5174

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web && npm run build:server

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5174 \
    CHROME_PATH=/usr/bin/chromium \
    SCREENSHOT_CACHE_DIR=/data/screenshots
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/web ./dist/web
COPY --from=build /app/dist/server ./dist/server
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 5174
CMD ["node", "dist/server/server.js"]
