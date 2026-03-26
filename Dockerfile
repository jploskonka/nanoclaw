FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY container/ ./container/
COPY groups/ ./groups/
COPY CLAUDE.md ./CLAUDE.md
COPY scripts/ ./scripts/
COPY setup/ ./setup/
ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
