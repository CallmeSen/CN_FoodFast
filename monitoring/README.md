# FoodFast Monitoring Stack

## 📊 Overview

Monitoring stack cho FoodFast microservices platform với:
- **Prometheus**: Thu thập metrics từ các services
- **Grafana**: Visualization & Dashboards
- **Blackbox Exporter**: Monitor endpoints HTTP/TCP
- **Alertmanager**: Xử lý alerts
- **prom-client**: Tích hợp trực tiếp trong code Node.js

## 🔧 Tích hợp Prometheus vào Code

Mỗi service đã được tích hợp `prom-client` để expose metrics:

### Metrics được thu thập:
- **HTTP Metrics**: Request rate, duration, status codes
- **Business Metrics**: Orders, payments, user auth
- **System Metrics**: CPU, memory, event loop lag
- **WebSocket**: Active connections
- **RabbitMQ**: Message throughput

### Cách sử dụng trong code:

```javascript
// CommonJS (api-gateway, user-service, product-service, order-service, payment-service)
const { setupMetrics, recordOrder, recordPayment } = require('../../../libs/common/metrics');

const app = express();
setupMetrics(app, 'service-name');  // Enable /metrics endpoint

// Record business events
recordOrder('completed', 'restaurant-123', 2.5);
recordPayment('success', 'credit_card', 150000);
```

```javascript
// ES Modules (email-service, socket-gateway)
import { setupMetrics, recordEmail } from '../../../libs/common/metrics.mjs';

setupMetrics(app, 'email-service');
recordEmail('verification', 'success');
```

## 🚀 Quick Start

### 1. Start monitoring stack

```powershell
cd monitoring
docker-compose up -d
```

### 2. Access dashboards

| Service | URL | Credentials |
|---------|-----|-------------|
| Grafana | http://localhost:3100 | admin / admin123 |
| Prometheus | http://localhost:9090 | - |
| Alertmanager | http://localhost:9093 | - |
| Blackbox Exporter | http://localhost:9115 | - |

## 📁 Directory Structure

```
monitoring/
├── docker-compose.yml
├── prometheus/
│   ├── prometheus.yml      # Prometheus config
│   └── alerts.yml          # Alert rules
├── blackbox/
│   └── blackbox.yml        # Endpoint probe config
├── alertmanager/
│   └── alertmanager.yml    # Alert routing
└── grafana/
    ├── provisioning/
    │   ├── datasources/    # Auto-configure Prometheus
    │   └── dashboards/     # Auto-load dashboards
    └── dashboards/
        ├── endpoints-dashboard.json
        └── services-dashboard.json
```

## 🔍 Monitored Endpoints

### Customer Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/customers/login` | POST | Customer login |
| `/api/customers/register` | POST | Customer registration |
| `/api/customers/verify` | POST | Email verification |
| `/api/customers/forgot-password` | POST | Password reset request |
| `/api/customers/addresses` | GET | List addresses |

### Restaurant Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/restaurants/login` | POST | Owner login |
| `/api/restaurants/signup` | POST | Owner signup |
| `/api/restaurants/verify` | POST | Owner verification |
| `/api/restaurants/catalog` | GET | List catalog |

### Admin Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/customers` | GET | List customers |
| `/api/admin/owners` | GET | List owners |

### Order Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/customer/orders` | GET | Customer orders |
| `/owner/orders` | GET | Owner orders |
| `/admin/orders` | GET | Admin orders |

### Service Health Checks
| Service | Endpoint |
|---------|----------|
| API Gateway | `/health` (port 8743) |
| User Service | `/health` (port 3001) |
| Product Service | `/health` (port 3002) |
| Order Service | `/health` (port 3003) |
| Payment Service | `/health` (port 3004) |
| Email Service | `/health` (port 3005) |
| Socket Gateway | `/health` (port 4000) |

## 📈 Grafana Dashboards

### 1. API Endpoints Monitor
- Endpoint status (UP/DOWN)
- Response time per endpoint
- Response time by category (customer, restaurant, order, admin)
- All endpoints status table
- Uptime percentage

### 2. Services Overview
- Service health status cards
- Response time trends
- Service availability history
- Overall system health

## ⚠️ Alert Rules

### Critical Alerts
- `EndpointDown`: Endpoint down > 1 minute
- `APIGatewayDown`: API Gateway unreachable
- `PaymentServiceDown`: Payment service down (business critical)
- `RabbitMQDown`: Message broker down

### Warning Alerts
- `EndpointSlowResponse`: Response > 2 seconds
- `HighErrorRate`: Error rate > 10%
- `SSLCertificateExpiringSoon`: SSL expires in < 30 days

## 🔧 Configuration

### Add new endpoint to monitor

Edit `prometheus/prometheus.yml`:

```yaml
- job_name: 'new-endpoint'
  metrics_path: /probe
  params:
    module: [http_2xx]
  static_configs:
    - targets:
        - http://api-gateway:8743/api/new/endpoint
      labels:
        service: api-gateway
        category: new-category
        endpoint: new-endpoint
        method: GET
  relabel_configs:
    - source_labels: [__address__]
      target_label: __param_target
    - source_labels: [__param_target]
      target_label: instance
    - target_label: __address__
      replacement: blackbox-exporter:9115
```

### Configure Alert Notifications

Edit `alertmanager/alertmanager.yml`:

```yaml
receivers:
  - name: 'slack-notifications'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
        channel: '#alerts'

  - name: 'email-notifications'
    email_configs:
      - to: 'ops-team@company.com'
        from: 'alertmanager@foodfast.local'
```

## 🔄 Useful Commands

```powershell
# Restart monitoring stack
docker-compose restart

# View logs
docker-compose logs -f prometheus
docker-compose logs -f grafana

# Reload Prometheus config
curl -X POST http://localhost:9090/-/reload

# Check Prometheus targets
curl http://localhost:9090/api/v1/targets

# Test blackbox probe
curl "http://localhost:9115/probe?target=http://api-gateway:8743/health&module=http_2xx"
```

## 📊 Prometheus Queries

```promql
# Endpoint availability
probe_success{service="api-gateway"}

# Response time in milliseconds
probe_http_duration_seconds * 1000

# Average response time by category
avg(probe_http_duration_seconds) by (category)

# Uptime percentage
avg(probe_success) * 100

# Failed endpoints count
count(probe_success == 0)
```

## 🔗 Integration with Backend

Make sure the backend services expose `/health` endpoint:

```javascript
// Add to each service's index.js
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    service: 'service-name',
    timestamp: new Date().toISOString()
  });
});
```

## ⚡ Requirements

- Docker & Docker Compose
- Network access to `server_backend_net` (from main docker-compose)
- Ports: 3100, 9090, 9093, 9100, 9115 available
