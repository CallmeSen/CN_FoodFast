FROM node:20-alpine

WORKDIR /app

# Copy package files from service directory
COPY ./apps/socket-gateway/package*.json ./
RUN apk add --no-cache curl && npm install

# Copy service source code
COPY ./apps/socket-gateway/ ./

# Copy shared libs
COPY ./libs ./libs

EXPOSE 4000

CMD ["node", "src/index.js"]
