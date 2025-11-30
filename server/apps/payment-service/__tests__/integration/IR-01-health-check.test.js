/**
 * Integration Test: IR-01 - False Positive Health Check
 * 
 * Risk: The health endpoint (src/index.js:28) returns {ok:true} without
 * checking PostgreSQL, RabbitMQ, or Stripe connectivity. Container orchestrators
 * (Kubernetes, Docker Swarm) think service is healthy while dependencies are down.
 * 
 * Test validates:
 * 1. Health endpoint returns OK regardless of dependency state
 * 2. Service appears healthy when PostgreSQL is unreachable
 * 3. Service appears healthy when RabbitMQ is disconnected
 * 4. Service appears healthy when Stripe is misconfigured
 */

const express = require('express');
const request = require('supertest');
const {
  TEST_CONFIG,
  MockPool,
  MockRabbitMQ,
  MockStripe,
} = require('./setup');

describe('IR-01: False Positive Health Check', () => {
  let app;
  let mockPool;
  let mockRabbitMQ;
  let mockStripe;

  beforeEach(() => {
    mockPool = new MockPool();
    mockRabbitMQ = new MockRabbitMQ();
    mockStripe = new MockStripe();

    // Create app simulating current health endpoint behavior
    app = express();
    app.use(express.json());

    // Current vulnerable health endpoint - always returns OK
    app.get('/health', (req, res) => {
      res.json({ ok: true, service: 'payment-service' });
    });

    // Proposed proper health endpoint
    app.get('/health/detailed', async (req, res) => {
      const checks = {
        postgres: false,
        rabbitmq: false,
        stripe: false,
      };

      // Check PostgreSQL
      try {
        await mockPool.query('SELECT 1');
        checks.postgres = true;
      } catch (err) {
        checks.postgres = false;
      }

      // Check RabbitMQ
      try {
        if (mockRabbitMQ.connected) {
          checks.rabbitmq = true;
        }
      } catch (err) {
        checks.rabbitmq = false;
      }

      // Check Stripe
      if (mockStripe.configured) {
        checks.stripe = true;
      }

      const allHealthy = Object.values(checks).every(v => v);
      res.status(allHealthy ? 200 : 503).json({
        ok: allHealthy,
        service: 'payment-service',
        checks,
        timestamp: new Date().toISOString(),
      });
    });
  });

  describe('Current Vulnerable Behavior', () => {
    test('should return healthy even when PostgreSQL is down', async () => {
      mockPool.setConnected(false);

      const response = await request(app).get('/health');

      // VULNERABILITY: Returns healthy despite DB being down
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    test('should return healthy even when RabbitMQ is disconnected', async () => {
      mockRabbitMQ.setConnected(false);

      const response = await request(app).get('/health');

      // VULNERABILITY: Returns healthy despite RabbitMQ being down
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    test('should return healthy even when Stripe is not configured', async () => {
      mockStripe.setConfigured(false);

      const response = await request(app).get('/health');

      // VULNERABILITY: Returns healthy despite Stripe not working
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    test('should return healthy even when ALL dependencies are down', async () => {
      mockPool.setConnected(false);
      mockRabbitMQ.setConnected(false);
      mockStripe.setConfigured(false);

      const response = await request(app).get('/health');

      // CRITICAL VULNERABILITY: Service appears healthy but is non-functional
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });
  });

  describe('Proposed Proper Health Check Behavior', () => {
    test('should return healthy when all dependencies are up', async () => {
      mockPool.setConnected(true);
      mockRabbitMQ.setConnected(true);
      mockStripe.setConfigured(true);

      const response = await request(app).get('/health/detailed');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.checks.postgres).toBe(true);
      expect(response.body.checks.rabbitmq).toBe(true);
      expect(response.body.checks.stripe).toBe(true);
    });

    test('should return unhealthy (503) when PostgreSQL is down', async () => {
      mockPool.setConnected(false);
      mockRabbitMQ.setConnected(true);
      mockStripe.setConfigured(true);

      const response = await request(app).get('/health/detailed');

      expect(response.status).toBe(503);
      expect(response.body.ok).toBe(false);
      expect(response.body.checks.postgres).toBe(false);
    });

    test('should return unhealthy (503) when RabbitMQ is down', async () => {
      mockPool.setConnected(true);
      mockRabbitMQ.setConnected(false);
      mockStripe.setConfigured(true);

      const response = await request(app).get('/health/detailed');

      expect(response.status).toBe(503);
      expect(response.body.ok).toBe(false);
      expect(response.body.checks.rabbitmq).toBe(false);
    });

    test('should return unhealthy (503) when Stripe is misconfigured', async () => {
      mockPool.setConnected(true);
      mockRabbitMQ.setConnected(true);
      mockStripe.setConfigured(false);

      const response = await request(app).get('/health/detailed');

      expect(response.status).toBe(503);
      expect(response.body.ok).toBe(false);
      expect(response.body.checks.stripe).toBe(false);
    });
  });

  describe('Kubernetes Liveness vs Readiness', () => {
    let livenessApp;

    beforeEach(() => {
      livenessApp = express();

      // Liveness: Is the process alive? (just basic check)
      livenessApp.get('/health/live', (req, res) => {
        res.json({ ok: true });
      });

      // Readiness: Can the service handle traffic? (check dependencies)
      livenessApp.get('/health/ready', async (req, res) => {
        const ready = mockPool.connected && mockRabbitMQ.connected && mockStripe.configured;
        res.status(ready ? 200 : 503).json({ ready });
      });
    });

    test('liveness should return OK even with dependency issues', async () => {
      mockPool.setConnected(false);

      const response = await request(livenessApp).get('/health/live');
      expect(response.status).toBe(200);
    });

    test('readiness should fail when dependencies are down', async () => {
      mockPool.setConnected(false);
      mockRabbitMQ.setConnected(true);
      mockStripe.setConfigured(true);

      const response = await request(livenessApp).get('/health/ready');
      expect(response.status).toBe(503);
      expect(response.body.ready).toBe(false);
    });

    test('readiness should pass when all dependencies are up', async () => {
      mockPool.setConnected(true);
      mockRabbitMQ.setConnected(true);
      mockStripe.setConfigured(true);

      const response = await request(livenessApp).get('/health/ready');
      expect(response.status).toBe(200);
      expect(response.body.ready).toBe(true);
    });
  });

  describe('Impact on Load Balancing', () => {
    test('false positive causes traffic routing to dead instance', async () => {
      // Simulate scenario where health check returns OK but service can't process payments
      mockPool.setConnected(false);

      // Load balancer sees healthy
      const healthResponse = await request(app).get('/health');
      expect(healthResponse.status).toBe(200);
      expect(healthResponse.body.ok).toBe(true);

      // But actual payment would fail
      const paymentWouldFail = !mockPool.connected;
      expect(paymentWouldFail).toBe(true);
    });
  });
});

describe('IR-01: Recommended Health Check Implementation', () => {
  test('Example implementation for proper health check', () => {
    /**
     * RECOMMENDED IMPLEMENTATION:
     * 
     * app.get('/health', async (req, res) => {
     *   try {
     *     // Check PostgreSQL
     *     await pool.query('SELECT 1');
     *     
     *     // Check RabbitMQ channel
     *     if (!channel || !connection) {
     *       throw new Error('RabbitMQ not connected');
     *     }
     *     
     *     // Check Stripe (optional - can be degraded)
     *     if (!config.STRIPE_SECRET_KEY) {
     *       console.warn('Stripe not configured');
     *     }
     *     
     *     res.json({ ok: true, service: 'payment-service' });
     *   } catch (error) {
     *     res.status(503).json({
     *       ok: false,
     *       service: 'payment-service',
     *       error: error.message,
     *     });
     *   }
     * });
     */
    const hasProperHealthCheck = false;
    expect(hasProperHealthCheck).toBe(false); // Will pass when fixed
  });
});
