# markerlayer ingestion & scoring API
#
#   docker build -t markerlayer .
#   docker run -p 3200:3200 -v markers-data:/data \
#     -e MARKERLAYER_API_KEYS=your-key-min-16-chars markerlayer

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-fund --no-audit
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3200 DATA_DIR=/data
# The server has zero runtime dependencies — only dist/ and package.json
# (for "type": "module") are needed.
COPY --from=build /app/dist ./dist
COPY package.json openapi.yaml ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3200
USER node
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:3200/health || exit 1
CMD ["node", "dist/server/main.js"]
