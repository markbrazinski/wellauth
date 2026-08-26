# Multi-stage: build the UI, then serve it from the provider itself.
# Same-origin means no CORS, no cross-origin cookie/WebMCP complexity, and one
# URL for a judge.
FROM node:22-slim AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY provider ./provider
# provider/fixture.js re-exports the payer's canonical fixture so the two
# services cannot drift apart on Act II dates.
COPY payer/fixture.js ./payer/fixture.js
COPY --from=ui /app/dist ./dist
ENV PORT=8080
ENV WELLAUTH_STATIC_DIR=/app/dist
CMD ["node", "provider/index.js"]
