FROM mirror.gcr.io/library/node:20-alpine

WORKDIR /app

RUN apk add --no-cache tzdata fontconfig ttf-dejavu && fc-cache -f || true

COPY package.json ./

ARG NPM_REGISTRY=https://registry.npmmirror.com

RUN npm config set registry ${NPM_REGISTRY} \
  && npm config set fetch-retries 8 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 180000 \
  && npm config set fetch-timeout 600000 \
  && npm install --omit=dev --no-audit --no-fund --loglevel=warn

COPY public ./public
COPY src ./src

CMD ["node", "src/index.js"]
