# syntax=docker/dockerfile:1
# MON PARKING — image de production (Node 24 embarque node:sqlite stable).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
# Sans cela le serveur ecoute sur 127.0.0.1 et le proxy du plateau ne joint rien.
ENV HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/lib/permissions.js ./src/lib/permissions.js
RUN mkdir -p /app/.server-data && chown -R node:node /app/.server-data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","--env-file-if-exists=.env","server/start.mjs"]
