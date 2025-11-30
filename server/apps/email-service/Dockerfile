FROM node:20-bullseye

WORKDIR /app

# Cài các gói cần thiết để build (nếu có thư viện cần build native)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        curl \
    && rm -rf /var/lib/apt/lists/*

# Copy file package.json from service directory
COPY ./apps/email-service/package*.json ./

# Cài đặt dependencies
RUN npm install

# Copy service source code
COPY ./apps/email-service/ ./

# Copy shared libs
COPY ./libs ./libs

# Biến môi trường production
ENV NODE_ENV=production

# Mở cổng service email (tuỳ chỉnh)
EXPOSE 3005

# Cho phép script entrypoint chạy
COPY ./apps/email-service/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/index.js"]
