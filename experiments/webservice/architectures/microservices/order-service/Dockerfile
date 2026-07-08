FROM node:18-alpine AS base

FROM base AS builder
WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

FROM base AS runner
WORKDIR /app

RUN apk add --no-cache curl

COPY --from=builder /app/node_modules ./node_modules

COPY . .

ENV NODE_ENV=production
ENV PORT=3003

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3003/health || exit 1

CMD ["node", "index.js"]