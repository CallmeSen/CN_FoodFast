# api-gateway/Dockerfile

FROM node:20-alpine

WORKDIR /app

# Copy package files from service directory
COPY ./apps/api-gateway/package*.json ./

RUN apk add --no-cache curl \
    && npm install --omit=dev

# Copy service source code
COPY ./apps/api-gateway/ ./

# Copy shared libs
COPY ./libs ./libs

COPY ./apps/api-gateway/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD [ "sh", "/entrypoint.sh" ]
