# Vorkath Bot v1 — reproducible EasyPanel deployment via Dockerfile.
# Railpack/Mise is not used on the VPS, so this file is the deployment path.
# No secrets here: sensitive config arrives only as runtime env vars from EasyPanel.
# No ARG/ENV with secrets is used during build on purpose.

FROM node:22.18.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY fixtures ./fixtures
RUN npm run build

FROM node:22.18.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Feature 1 reads the MOCK fixture at runtime, so it ships inside the image.
COPY --from=build /app/fixtures ./fixtures
# /data stays external (EasyPanel volume) and is intentionally NOT copied
# and NOT declared as VOLUME in the image.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => { if (!r.ok) process.exit(1) })"
CMD ["npm", "start"]
