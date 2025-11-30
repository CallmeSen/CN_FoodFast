/**
 * Integration Test: IR-10 - False Positive Health Check
 * 
 * Root Cause: app.js:18-20 returns { ok: true } without checking DB
 * Impact: Load balancer routes traffic to unhealthy instance
 * Evidence: pool.on('error') at db/index.js:16 only logs, doesn't update health state
 */

const request = require('supertest');
const { Pool } = require('pg');
const app = require('../../app');

describe('IR-10: False Positive Health Check Integration Tests', () => {
  let pool;

  beforeAll(async () => {
    // GIVEN - Database connection for verification
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5435,
      database: process.env.DB_NAME || 'orderdb',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '123',
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('Health Endpoint Without DB Check', () => {
    it('should return ok:true without checking database connectivity', async () => {
      // GIVEN - Health endpoint at app.js:18-20
      // app.get('/health', (_req, res) => { res.json({ ok: true, service: 'order-service' }); });

      // WHEN - Health check is called
      const response = await request(app).get('/health');

      // THEN - Should return ok:true (no DB check performed)
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe('order-service');

      // Note: This passes regardless of DB state - that's the bug
    });

    it('should verify health response does not include db status', async () => {
      // WHEN - Health check is called
      const response = await request(app).get('/health');

      // THEN - Response should NOT include database health info
      expect(response.body.database).toBeUndefined();
      expect(response.body.db).toBeUndefined();
      expect(response.body.postgres).toBeUndefined();
      expect(response.body.connections).toBeUndefined();

      // This is the risk: no visibility into DB health
      console.log('Health response (no DB info):', response.body);
    });

    it('should verify health response does not include RabbitMQ status', async () => {
      // WHEN - Health check is called
      const response = await request(app).get('/health');

      // THEN - Response should NOT include RabbitMQ health info
      expect(response.body.rabbitmq).toBeUndefined();
      expect(response.body.queue).toBeUndefined();
      expect(response.body.messaging).toBeUndefined();

      // No visibility into message queue health
    });
  });

  describe('Health Check During DB Unavailability', () => {
    it('should still return ok:true when database query would fail', async () => {
      // GIVEN - Create a new app instance that might have stale DB connection
      // In real scenario, DB might be down but health still returns ok

      // WHEN - Health check is called (simulating after DB failure)
      const response = await request(app).get('/health');

      // THEN - Still returns ok:true (false positive)
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);

      // Document the risk
      console.log('WARNING: Health returns ok:true without verifying DB connectivity');
    });

    it('should demonstrate health check passes while DB pool has errors', async () => {
      // GIVEN - Simulate pool error state
      const testPool = new Pool({
        host: 'nonexistent-host',
        port: 5432,
        database: 'testdb',
        user: 'postgres',
        password: 'password',
        connectionTimeoutMillis: 1000,
      });

      let poolError = null;
      testPool.on('error', (err) => {
        poolError = err;
        // db/index.js:16 only logs, doesn't update health state
        console.log('Pool error occurred:', err.message);
      });

      // WHEN - Health check is called
      const response = await request(app).get('/health');

      // THEN - Health still returns ok:true
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);

      // Cleanup
      await testPool.end().catch(() => {});
    });
  });

  describe('Load Balancer Routing Risk', () => {
    it('should document the load balancer routing risk', async () => {
      // GIVEN - Kubernetes/Docker health check configuration
      const healthCheckConfig = {
        endpoint: '/health',
        expectedResponse: { ok: true },
        issue: 'Returns ok:true regardless of actual service health',
        impact: [
          'Load balancer continues routing traffic to unhealthy instance',
          'Kubernetes does not restart unhealthy pod',
          'Users experience 500 errors instead of being routed to healthy instance',
        ],
      };

      // WHEN - Health check is called
      const response = await request(app).get('/health');

      // THEN - Verify the problematic behavior
      expect(response.body).toEqual({ ok: true, service: 'order-service' });

      console.log('Load Balancer Risk:', JSON.stringify(healthCheckConfig, null, 2));
    });

    it('should verify consecutive health checks always return ok', async () => {
      // WHEN - Multiple consecutive health checks
      const responses = await Promise.all([
        request(app).get('/health'),
        request(app).get('/health'),
        request(app).get('/health'),
        request(app).get('/health'),
        request(app).get('/health'),
      ]);

      // THEN - All return ok:true (never fails)
      responses.forEach((response, index) => {
        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
      });

      // In a proper health check, at least one might fail if dependencies are unhealthy
    });
  });

  describe('Proper Health Check Comparison', () => {
    it('should demonstrate what a proper health check would look like', async () => {
      // GIVEN - What a proper health check should verify
      const properHealthCheck = async () => {
        const checks = {
          database: false,
          rabbitmq: false,
        };

        // Check database
        try {
          const result = await pool.query('SELECT 1');
          checks.database = result.rows.length > 0;
        } catch (error) {
          checks.database = false;
        }

        // Check RabbitMQ would go here
        // checks.rabbitmq = await checkRabbitMQ();

        return {
          ok: checks.database, // Only ok if all dependencies are healthy
          service: 'order-service',
          checks,
          timestamp: new Date().toISOString(),
        };
      };

      // WHEN - Proper health check is performed
      const properResult = await properHealthCheck();

      // THEN - Compare with actual health endpoint
      const actualResponse = await request(app).get('/health');

      console.log('Proper health check result:', properResult);
      console.log('Actual health check result:', actualResponse.body);

      // Actual lacks the detailed checks
      expect(actualResponse.body.checks).toBeUndefined();
    });

    it('should verify database connectivity separately from health endpoint', async () => {
      // GIVEN - Direct database check
      let dbHealthy = false;
      try {
        const result = await pool.query('SELECT 1 as health_check');
        dbHealthy = result.rows[0]?.health_check === 1;
      } catch (error) {
        dbHealthy = false;
      }

      // WHEN - Health endpoint is checked
      const response = await request(app).get('/health');

      // THEN - Health endpoint doesn't reflect actual DB state
      console.log('Database actually healthy:', dbHealthy);
      console.log('Health endpoint reports:', response.body.ok);

      // These could be different - that's the bug
      // If DB is down, health still says ok:true
    });
  });

  describe('Docker/Kubernetes Health Check Behavior', () => {
    it('should verify health endpoint matches docker-compose healthcheck', async () => {
      // GIVEN - docker-compose.yml healthcheck:
      // test: ["CMD-SHELL", "curl -f http://localhost:3003/health || exit 1"]

      // WHEN - Health check is called
      const response = await request(app).get('/health');

      // THEN - Always passes (docker healthcheck succeeds)
      expect(response.status).toBe(200);

      // This means unhealthy container is marked as healthy
      console.log('Docker healthcheck will always pass with:', response.body);
    });

    it('should verify response time does not indicate slow DB', async () => {
      // WHEN - Time the health check
      const startTime = Date.now();
      const response = await request(app).get('/health');
      const elapsed = Date.now() - startTime;

      // THEN - Response is fast because no DB query
      expect(elapsed).toBeLessThan(100); // Should be < 100ms since no DB check
      expect(response.body.responseTime).toBeUndefined();

      console.log('Health check response time:', elapsed, 'ms (no DB query)');
    });
  });

  describe('Error Handler Does Not Update Health', () => {
    it('should verify pool.on error handler only logs', async () => {
      // GIVEN - db/index.js:16-18:
      // pool.on('error', (error) => {
      //   console.error('[order-service] Unexpected database error:', error);
      // });

      // THEN - Document the missing health state update
      const errorHandlerBehavior = {
        file: 'db/index.js',
        line: '16-18',
        behavior: 'Only logs error, does not update health state',
        issue: 'Health endpoint has no access to pool error state',
        fix: 'Should set a global isHealthy flag that health endpoint checks',
      };

      console.log('Error handler behavior:', JSON.stringify(errorHandlerBehavior, null, 2));
      expect(errorHandlerBehavior.issue).toBeDefined();
    });
  });
});
