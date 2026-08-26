FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY provider ./provider
ENV PORT=8080
CMD ["node", "provider/index.js"]
