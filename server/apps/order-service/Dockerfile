FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache postgresql-client curl

# Copy package files from service directory
COPY ./apps/order-service/package*.json ./
RUN npm install --omit=dev

# Copy service source code
COPY ./apps/order-service/ ./
COPY ./apps/order-service/src ./src

# Copy shared libs
COPY ./libs ./libs

ENV NODE_ENV=production
EXPOSE 3003
COPY ./apps/order-service/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]

