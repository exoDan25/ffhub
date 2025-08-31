FROM node:18
WORKDIR /app

# Install CA certificates
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --production
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
