# Node LTS léger
FROM node:20-alpine

# curl pour le healthcheck
RUN apk add --no-cache curl

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js .

# Non-root (le compose force aussi user: PUID:PGID)
USER node

EXPOSE 18080

# /health public, renvoie {"ok":true}
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:18080/health || exit 1

CMD ["node", "index.js"]
