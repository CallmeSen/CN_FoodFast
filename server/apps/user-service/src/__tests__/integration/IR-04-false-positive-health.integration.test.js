/**
 * Integration Test: IR-04 - False Positive Health Check
 * 
 * Risk: index.js:26-28 returns {status:'ok'} without checking DB/RabbitMQ
 *       Kubernetes will think service is healthy when dependencies are down
 * 
 * Impact: HIGH - False liveness leads to routing traffic to dead pods
 * 
 * Target Code (index.js:26-28):
 * ```javascript
 * app.get('/health', (req, res) => {
 *   res.json({ status: 'ok' });  // No actual health check!
 * });
 * ```
 * 
 * Reproduction:
 *   docker stop foodfast-userdb foodfast-rabbitmq
 *   curl http://localhost:3001/health  # Still returns {"status":"ok"}
 */

const request = require('supertest');
const express = require('express');
const { Pool } = require('pg');

describe('IR-04: False Positive Health Check', () => {
  let app;
  let testPool;
  let mockRabbitmq;

  beforeAll(() => {
    // Create a test pool that we can control
    testPool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'userdb',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '123',
      max: 2, // Small pool for testing
    });
  });

  afterAll(async () => {
    if (testPool) {
      await testPool.end();
    }
  });

  beforeEach(() => {
    jest.resetModules();
    
    mockRabbitmq = {
      connectRabbitMQ: jest.fn().mockResolvedValue(undefined),
      publishToEmailQueue: jest.fn(),
      publishSocketEvent: jest.fn(),
    };
    
    jest.doMock('../../utils/rabbitmq', () => mockRabbitmq);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Current Behavior (Vulnerable)', () => {
    test('VULNERABILITY: Health returns OK even when DB is not checked', async () => {
      // Create app with current health endpoint
      app = express();
      
      // Current implementation - doesn't check anything
      app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
      });

      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      // No DB query was made - health is false positive
    });

    test('VULNERABILITY: Health OK even with invalid DB config', async () => {
      app = express();
      
      // Simulate bad config (won't be checked by current health endpoint)
      const badPool = new Pool({
        host: 'non-existent-host',
        port: 5432,
        database: 'wrongdb',
        user: 'wrong',
        password: 'wrong',
        connectionTimeoutMillis: 1000,
      });

      // Current health endpoint doesn't use pool at all
      app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
      });

      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      // Health reports OK but service can't actually function
      
      await badPool.end().catch(() => {}); // Cleanup
    });
  });

  describe('What Health Check SHOULD Do', () => {
    test('EXPECTED: Proper health check verifies DB connection', async () => {
      app = express();
      
      // FIXED implementation
      app.get('/health', async (req, res) => {
        try {
          // Actually check database
          const client = await testPool.connect();
          await client.query('SELECT 1');
          client.release();
          
          res.json({ 
            status: 'ok',
            db: 'connected',
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          res.status(503).json({
            status: 'unhealthy',
            db: 'disconnected',
            error: error.message,
          });
        }
      });

      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      expect(response.body.db).toBe('connected');
    });

    test('EXPECTED: Health fails when DB is unreachable', async () => {
      const badPool = new Pool({
        host: 'localhost',
        port: 59999, // Wrong port - nothing listening
        database: 'userdb',
        user: 'postgres',
        password: '123',
        connectionTimeoutMillis: 1000,
      });

      app = express();
      
      app.get('/health', async (req, res) => {
        try {
          const client = await badPool.connect();
          await client.query('SELECT 1');
          client.release();
          res.json({ status: 'ok', db: 'connected' });
        } catch (error) {
          res.status(503).json({
            status: 'unhealthy',
            db: 'disconnected',
            error: error.message,
          });
        }
      });

      const response = await request(app)
        .get('/health')
        .expect(503);

      expect(response.body.status).toBe('unhealthy');
      expect(response.body.db).toBe('disconnected');
      
      await badPool.end().catch(() => {});
    });

    test('EXPECTED: Health includes RabbitMQ status', async () => {
      let rabbitmqConnected = true; // Simulated state
      
      app = express();
      
      app.get('/health', async (req, res) => {
        const checks = {
          db: false,
          rabbitmq: rabbitmqConnected,
        };

        try {
          const client = await testPool.connect();
          await client.query('SELECT 1');
          client.release();
          checks.db = true;
        } catch (e) {
          checks.db = false;
        }

        const allHealthy = checks.db && checks.rabbitmq;
        
        res.status(allHealthy ? 200 : 503).json({
          status: allHealthy ? 'ok' : 'unhealthy',
          checks,
          timestamp: new Date().toISOString(),
        });
      });

      // When both healthy
      let response = await request(app).get('/health').expect(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.checks.db).toBe(true);
      expect(response.body.checks.rabbitmq).toBe(true);

      // When RabbitMQ down
      rabbitmqConnected = false;
      response = await request(app).get('/health').expect(503);
      expect(response.body.status).toBe('unhealthy');
      expect(response.body.checks.rabbitmq).toBe(false);
    });
  });

  describe('Kubernetes Impact', () => {
    test('IMPACT: Liveness probe passes - pod stays running when broken', async () => {
      app = express();
      
      // Current vulnerable endpoint
      app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
      });

      // Simulating Kubernetes liveness probe
      const livenessCheck = async () => {
        const response = await request(app).get('/health');
        return response.status === 200;
      };

      // Even if DB is down, liveness passes
      const isAlive = await livenessCheck();
      expect(isAlive).toBe(true);
      
      // Pod won't be restarted even though it's broken
    });

    test('IMPACT: Readiness probe passes - traffic routed to broken pod', async () => {
      app = express();
      
      // Current vulnerable endpoint
      app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
      });

      // Simulating Kubernetes readiness probe
      const readinessCheck = async () => {
        const response = await request(app).get('/health');
        return response.status === 200;
      };

      const isReady = await readinessCheck();
      expect(isReady).toBe(true);
      
      // Traffic will be sent to this pod even though it can't serve requests
    });
  });
});

/**
 * REMEDIATION:
 * 
 * Replace the simple health endpoint with comprehensive checks:
 * 
 * ```javascript
 * // index.js
 * const { pool } = require('./db');
 * 
 * // Track RabbitMQ connection state
 * let rabbitmqConnected = false;
 * 
 * app.get('/health', async (req, res) => {
 *   const checks = {
 *     db: false,
 *     rabbitmq: rabbitmqConnected,
 *   };
 * 
 *   try {
 *     const client = await pool.connect();
 *     await client.query('SELECT 1');
 *     client.release();
 *     checks.db = true;
 *   } catch (error) {
 *     console.error('Health check DB failed:', error.message);
 *   }
 * 
 *   const allHealthy = checks.db && checks.rabbitmq;
 *   
 *   res.status(allHealthy ? 200 : 503).json({
 *     status: allHealthy ? 'ok' : 'unhealthy',
 *     checks,
 *     timestamp: new Date().toISOString(),
 *   });
 * });
 * 
 * // Separate liveness (is process running) vs readiness (can serve traffic)
 * app.get('/live', (req, res) => {
 *   res.json({ status: 'alive' }); // Just checks process is responding
 * });
 * 
 * app.get('/ready', async (req, res) => {
 *   // Full dependency check for readiness
 *   // ... same as /health above
 * });
 * ```
 * 
 * Kubernetes config:
 * ```yaml
 * livenessProbe:
 *   httpGet:
 *     path: /live
 *     port: 3001
 *   initialDelaySeconds: 10
 *   periodSeconds: 10
 * 
 * readinessProbe:
 *   httpGet:
 *     path: /ready
 *     port: 3001
 *   initialDelaySeconds: 5
 *   periodSeconds: 5
 * ```
 */
