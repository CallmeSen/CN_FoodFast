# FROM node:20-alpine
# WORKDIR /app
# RUN apk add --no-cache postgresql-client
# COPY package*.json ./
# RUN npm install --omit=dev
# COPY . .
# COPY ./src ./src
# ENV NODE_ENV=production
# EXPOSE 3002
# COPY entrypoint.sh /entrypoint.sh
# RUN chmod +x /entrypoint.sh
# ENTRYPOINT ["/entrypoint.sh"]
# CMD ["node", "server.js"]

# Stage 1: Base image
FROM node:20-bullseye

# Set working directory
WORKDIR /app

# Install PostgreSQL client and curl
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-client \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package files from service directory
COPY ./apps/product-service/package*.json ./

# Use npm install to avoid lock mismatch errors when package.json changes
RUN npm install --only=production --no-audit --no-fund

# Copy service source code
COPY ./apps/product-service/ ./
COPY ./apps/product-service/src ./src

# Copy shared libs
COPY ./libs ./libs

# Set environment
ENV NODE_ENV=production

# Expose port
EXPOSE 3002

# Entrypoint
COPY ./apps/product-service/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

# Default command
CMD ["node", "server.js"]
