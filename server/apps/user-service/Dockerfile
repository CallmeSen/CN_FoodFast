FROM node:20-bullseye

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-client \
        python3 \
        build-essential \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package files from service directory
COPY ./apps/user-service/package*.json ./

RUN npm install

# Copy service source code
COPY ./apps/user-service/ ./

# Copy shared libs
COPY ./libs ./libs

## bcrypt native module usually builds during npm install.
## Remove explicit rebuild to avoid node-gyp-build missing errors.
## If a build is still needed, npm will trigger it during install.

ENV NODE_ENV=production

EXPOSE 3001

COPY ./apps/user-service/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/index.js"]
