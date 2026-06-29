FROM mirror.gcr.io/library/node:20-alpine

WORKDIR /app
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ENV NODE_OPTIONS=--use-openssl-ca
ENV NODE_TLS_REJECT_UNAUTHORIZED=0

RUN apk add --no-cache tzdata ca-certificates openssl
RUN update-ca-certificates

COPY package.json ./
RUN npm install --omit=dev

COPY public ./public
COPY src ./src
CMD ["node", "src/index.js"]
