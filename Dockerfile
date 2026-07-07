# ── Stage 1: build shared types ─────────────────────────────────────────────
FROM node:22-alpine AS build-shared
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY shared/ ./shared/
RUN npm ci --workspace=shared

# ── Stage 2: build client (React/Vite) ─────────────────────────────────────
FROM node:22-alpine AS build-client
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY client/package.json ./client/
COPY --from=build-shared /app/shared ./shared
# Install only client deps
RUN npm ci --workspace=client
COPY client/ ./client/
RUN npm run build -w client

# ── Stage 3: build server (TypeScript) ─────────────────────────────────────
FROM node:22-alpine AS build-server
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY --from=build-shared /app/shared ./shared
# Install all server deps (including devDependencies for tsc)
RUN npm ci --workspace=server
COPY server/ ./server/
RUN npm run build -w server

# ── Stage 4: production image ───────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY --from=build-shared /app/shared ./shared
RUN npm ci --workspace=server --omit=dev

# Copy built artifacts
COPY --from=build-server /app/server/dist ./server/dist
COPY --from=build-client /app/client/dist ./client/dist

# Expose server port
ENV PORT=3000
ENV HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 3000

# Data directory for SQLite DB (mount Render Persistent Disk here)
VOLUME ["/app/server/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/ping').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
