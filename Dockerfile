FROM mirror.gcr.io/library/node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache \
      ca-certificates \
      openssl \
      fontconfig \
      ttf-dejavu \
      tzdata \
    && update-ca-certificates \
    && fc-cache -f

COPY package*.json ./

RUN npm install --omit=dev

COPY certs/russian_trusted_root_ca.crt \
  /usr/local/share/ca-certificates/russian_trusted_root_ca.crt

COPY certs/russian_trusted_sub_ca.crt \
  /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt

RUN update-ca-certificates

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV NODE_OPTIONS=--use-openssl-ca

COPY public ./public
COPY src ./src

CMD ["node", "src/index.js"]
