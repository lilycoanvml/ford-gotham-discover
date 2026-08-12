# ── Stage 1: Install dependencies ──────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Build ──────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time env vars (non-secret — API keys must NOT be baked in here)
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: Run ────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run injects PORT automatically. The gateway binds it and runs the Next
# standalone server on INTERNAL_PORT behind itself — one public port, two
# servers, because /api/live is a WebSocket that Next cannot serve.
ENV PORT=8080
ENV INTERNAL_PORT=8081
ENV HOSTNAME=0.0.0.0

# Use non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs

# Copy the standalone output produced by output: 'standalone'. This includes
# Next's own generated server.js at the root — the gateway sits in front of it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public           ./public

# The live relay is plain CJS outside the Next build, so it is copied verbatim
# rather than traced. shared/ carries the question wording both sides read.
COPY --chown=nextjs:nodejs gateway.js ./gateway.js
COPY --chown=nextjs:nodejs live       ./live
COPY --chown=nextjs:nodejs shared     ./shared

# `ws` is a runtime dependency of the relay. Next's tracer only sees it if a
# bundled route imports it, and /api/tts does today — but the relay must not
# depend on that staying true, so install it explicitly.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/ws ./node_modules/ws

USER nextjs
EXPOSE 8080

CMD ["node", "gateway.js"]
