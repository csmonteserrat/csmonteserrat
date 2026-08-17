# Imagem com Node.js + espeak-ng (voz em português gerada no servidor)
FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends espeak-ng \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
