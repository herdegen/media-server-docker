# Utilise Node LTS léger
FROM node:20-alpine

# Sécurité de base + curl pour healthcheck
RUN apk add --no-cache curl

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm i --only=production

COPY index.js .

# Port HTTP du MCP (ici 8080)
EXPOSE 18080

# Healthcheck simple (renvoie 200 sur /health)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:18080/health || exit 1

CMD ["node", "index.js"]

