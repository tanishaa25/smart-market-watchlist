# Backend — Node/Express API
FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies first, in their own layer, so `docker build` only
# re-runs npm install when package.json actually changes, not on every
# source-code edit.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

# Runs as a non-root user — the "node" user already exists in the
# official node:alpine image, no need to create one.
USER node

EXPOSE 4000
ENV PORT=4000
ENV NODE_ENV=production

# GOOGLE_APPLICATION_CREDENTIALS, JWT_SECRET, FINNHUB_API_KEY, and
# GEMINI_API_KEY are expected to be supplied at runtime (see
# .env.example) — never baked into the image.
CMD ["node", "src/server.js"]
