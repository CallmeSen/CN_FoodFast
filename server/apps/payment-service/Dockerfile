FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache postgresql-client curl

# Copy package files from service directory
COPY ./apps/payment-service/package*.json ./
RUN npm install --omit=dev

# Copy service source code
COPY ./apps/payment-service/ ./

# Copy shared libs
COPY ./libs ./libs

ENV NODE_ENV=production
EXPOSE 3004
COPY ./apps/payment-service/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/index.js"]
