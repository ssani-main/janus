# Production image for Coolify (build pack: Dockerfile).
# Node is pinned to an exact patched release: bump it when Node ships a security release
# (https://nodejs.org/en/blog/vulnerability). Nixpacks was dropped because it ships an
# old Node from its own Nix snapshot and cannot follow security releases.
# Debian (glibc), not Alpine: holesail's native UDX module ships glibc prebuilds.
FROM node:22.23.4-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# The store lives on the Coolify volume mounted at /app/data (STORE_PATH).
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "src/server.js"]
