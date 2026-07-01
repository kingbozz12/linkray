FROM mirror.gcr.io/library/node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache fontconfig ttf-dejavu && fc-cache -f || true tzdata && fc-cache -f || true

COPY package*.json ./
RUN npm install --omit=dev

COPY public ./public
COPY src ./src

CMD ["node", "src/index.js"]
