FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
