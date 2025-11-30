/**
 * Prometheus Metrics Module for FoodFast Microservices (ES Modules version)
 * 
 * Provides:
 * - HTTP request metrics (duration, count, status)
 * - Custom business metrics
 * - /metrics endpoint for Prometheus scraping
 */

import client from 'prom-client';

// Create a Registry to register metrics
const register = new client.Registry();

// Add default labels
register.setDefaultLabels({
  app: 'foodfast'
});

// Collect default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// ============================================
// HTTP Request Metrics
// ============================================

// HTTP request duration histogram
const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code', 'service'],
  buckets: [0.001, 0.005, 0.015, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 1, 2, 5, 10]
});
register.registerMetric(httpRequestDuration);

// HTTP request counter
const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code', 'service']
});
register.registerMetric(httpRequestTotal);

// HTTP request in progress
const httpRequestsInProgress = new client.Gauge({
  name: 'http_requests_in_progress',
  help: 'Number of HTTP requests currently being processed',
  labelNames: ['service']
});
register.registerMetric(httpRequestsInProgress);

// WebSocket connections
const wsConnectionsTotal = new client.Gauge({
  name: 'websocket_connections_total',
  help: 'Total number of active WebSocket connections',
  labelNames: ['service']
});
register.registerMetric(wsConnectionsTotal);

// Emails sent
const emailsSentTotal = new client.Counter({
  name: 'emails_sent_total',
  help: 'Total number of emails sent',
  labelNames: ['type', 'status']
});
register.registerMetric(emailsSentTotal);

// RabbitMQ message metrics
const rabbitMQMessagesTotal = new client.Counter({
  name: 'rabbitmq_messages_total',
  help: 'Total number of RabbitMQ messages',
  labelNames: ['queue', 'type']
});
register.registerMetric(rabbitMQMessagesTotal);

// Error counter
const errorsTotal = new client.Counter({
  name: 'errors_total',
  help: 'Total number of errors',
  labelNames: ['service', 'type', 'code']
});
register.registerMetric(errorsTotal);

// ============================================
// Express Middleware
// ============================================

/**
 * Middleware to track HTTP request metrics
 */
function metricsMiddleware(serviceName) {
  return (req, res, next) => {
    if (req.path === '/metrics') {
      return next();
    }

    const startTime = Date.now();
    httpRequestsInProgress.inc({ service: serviceName });

    const getRoute = () => {
      let route = req.route?.path || req.path;
      route = route.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
      route = route.replace(/\/\d+/g, '/:id');
      return route;
    };

    res.on('finish', () => {
      const duration = (Date.now() - startTime) / 1000;
      const route = getRoute();
      const labels = {
        method: req.method,
        route: route,
        status_code: res.statusCode,
        service: serviceName
      };

      httpRequestDuration.observe(labels, duration);
      httpRequestTotal.inc(labels);
      httpRequestsInProgress.dec({ service: serviceName });
    });

    next();
  };
}

/**
 * Create metrics endpoint handler
 */
async function metricsHandler(req, res) {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
}

/**
 * Setup metrics for Express app
 */
function setupMetrics(app, serviceName) {
  app.use(metricsMiddleware(serviceName));
  app.get('/metrics', metricsHandler);
  console.log(`📊 Prometheus metrics enabled for ${serviceName} at /metrics`);
}

// Utility functions
function recordEmail(type, status) {
  emailsSentTotal.inc({ type, status });
}

function recordError(service, type, code) {
  errorsTotal.inc({ service, type: type || 'unknown', code: String(code || 500) });
}

function recordRabbitMQMessage(queue, type) {
  rabbitMQMessagesTotal.inc({ queue, type });
}

function setWsConnections(service, count) {
  wsConnectionsTotal.set({ service }, count);
}

export {
  register,
  client,
  setupMetrics,
  metricsMiddleware,
  metricsHandler,
  httpRequestDuration,
  httpRequestTotal,
  httpRequestsInProgress,
  wsConnectionsTotal,
  emailsSentTotal,
  rabbitMQMessagesTotal,
  errorsTotal,
  recordEmail,
  recordError,
  recordRabbitMQMessage,
  setWsConnections
};
