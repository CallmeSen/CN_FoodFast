/**
 * Prometheus Metrics Module for FoodFast Microservices
 * 
 * Provides:
 * - HTTP request metrics (duration, count, status)
 * - Custom business metrics
 * - /metrics endpoint for Prometheus scraping
 */

const client = require('prom-client');

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

// ============================================
// Business Metrics
// ============================================

// Orders metrics
const ordersTotal = new client.Counter({
  name: 'orders_total',
  help: 'Total number of orders',
  labelNames: ['status', 'restaurant_id']
});
register.registerMetric(ordersTotal);

// Order processing time
const orderProcessingTime = new client.Histogram({
  name: 'order_processing_duration_seconds',
  help: 'Time taken to process an order',
  labelNames: ['status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120]
});
register.registerMetric(orderProcessingTime);

// Payment metrics
const paymentsTotal = new client.Counter({
  name: 'payments_total',
  help: 'Total number of payments',
  labelNames: ['status', 'payment_method']
});
register.registerMetric(paymentsTotal);

const paymentAmount = new client.Histogram({
  name: 'payment_amount',
  help: 'Payment amounts distribution',
  labelNames: ['payment_method'],
  buckets: [10000, 50000, 100000, 200000, 500000, 1000000, 2000000]
});
register.registerMetric(paymentAmount);

// User registration/login metrics
const userAuthTotal = new client.Counter({
  name: 'user_auth_total',
  help: 'Total number of user authentication events',
  labelNames: ['type', 'status', 'user_type']  // type: login, register, verify
});
register.registerMetric(userAuthTotal);

// Active users gauge
const activeUsers = new client.Gauge({
  name: 'active_users',
  help: 'Number of currently active users',
  labelNames: ['user_type']
});
register.registerMetric(activeUsers);

// Restaurant metrics
const restaurantsTotal = new client.Gauge({
  name: 'restaurants_total',
  help: 'Total number of restaurants',
  labelNames: ['status']
});
register.registerMetric(restaurantsTotal);

// Products metrics
const productsTotal = new client.Gauge({
  name: 'products_total',
  help: 'Total number of products',
  labelNames: ['category', 'restaurant_id']
});
register.registerMetric(productsTotal);

// RabbitMQ message metrics
const rabbitMQMessagesTotal = new client.Counter({
  name: 'rabbitmq_messages_total',
  help: 'Total number of RabbitMQ messages',
  labelNames: ['queue', 'type']  // type: published, consumed
});
register.registerMetric(rabbitMQMessagesTotal);

// Database query metrics
const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'table', 'service'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});
register.registerMetric(dbQueryDuration);

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
 * @param {string} serviceName - Name of the service
 */
function metricsMiddleware(serviceName) {
  return (req, res, next) => {
    // Skip metrics endpoint itself
    if (req.path === '/metrics') {
      return next();
    }

    const startTime = Date.now();
    httpRequestsInProgress.inc({ service: serviceName });

    // Normalize route for metrics (replace IDs with :id)
    const getRoute = () => {
      let route = req.route?.path || req.path;
      // Replace UUIDs and numeric IDs with placeholder
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
 * @param {object} app - Express app
 * @param {string} serviceName - Name of the service
 */
function setupMetrics(app, serviceName) {
  // Add metrics middleware
  app.use(metricsMiddleware(serviceName));
  
  // Add metrics endpoint
  app.get('/metrics', metricsHandler);
  
  console.log(`📊 Prometheus metrics enabled for ${serviceName} at /metrics`);
}

// ============================================
// Utility Functions
// ============================================

/**
 * Record order metric
 */
function recordOrder(status, restaurantId, processingTimeSeconds) {
  ordersTotal.inc({ status, restaurant_id: restaurantId || 'unknown' });
  if (processingTimeSeconds) {
    orderProcessingTime.observe({ status }, processingTimeSeconds);
  }
}

/**
 * Record payment metric
 */
function recordPayment(status, paymentMethod, amount) {
  paymentsTotal.inc({ status, payment_method: paymentMethod });
  if (amount) {
    paymentAmount.observe({ payment_method: paymentMethod }, amount);
  }
}

/**
 * Record user auth event
 */
function recordUserAuth(type, status, userType) {
  userAuthTotal.inc({ type, status, user_type: userType });
}

/**
 * Record error
 */
function recordError(service, type, code) {
  errorsTotal.inc({ service, type: type || 'unknown', code: String(code || 500) });
}

/**
 * Record RabbitMQ message
 */
function recordRabbitMQMessage(queue, type) {
  rabbitMQMessagesTotal.inc({ queue, type });
}

/**
 * Record database query
 */
function recordDbQuery(operation, table, service, durationSeconds) {
  dbQueryDuration.observe({ operation, table, service }, durationSeconds);
}

module.exports = {
  register,
  client,
  setupMetrics,
  metricsMiddleware,
  metricsHandler,
  // Business metrics
  ordersTotal,
  orderProcessingTime,
  paymentsTotal,
  paymentAmount,
  userAuthTotal,
  activeUsers,
  restaurantsTotal,
  productsTotal,
  rabbitMQMessagesTotal,
  dbQueryDuration,
  errorsTotal,
  httpRequestDuration,
  httpRequestTotal,
  httpRequestsInProgress,
  // Utility functions
  recordOrder,
  recordPayment,
  recordUserAuth,
  recordError,
  recordRabbitMQMessage,
  recordDbQuery
};
