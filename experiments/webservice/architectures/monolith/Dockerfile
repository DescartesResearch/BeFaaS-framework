FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY index.js ./
COPY call.js ./
COPY functions/ ./functions/
COPY auth/ ./auth/

COPY shared/ ./shared/

COPY productcatalog/ ./productcatalog/
COPY currency/ ./currency/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "index.js"]