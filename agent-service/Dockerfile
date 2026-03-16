FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 9860

CMD ["node", "server.mjs"]
