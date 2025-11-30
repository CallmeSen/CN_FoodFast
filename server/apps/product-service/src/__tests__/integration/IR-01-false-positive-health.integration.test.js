/**
 * Integration Test: IR-01 - False Positive Health Check
 * 
 * Risk: index.js:25-27 returns {status:'ok'} without checking DB or RabbitMQ
 *       Kubernetes will route traffic to broken pods
 * 
 * Impact: HIGH - False liveness/readiness leads to service failures
 * 
 * Target Code (index.js:25-27):
 * ```javascript
 * app.get('/health', (req, res) => {
 *   res.json({ status: 'ok' });  // No actual dependency check!
 * });
 * ```
 * 
 * Reproduction:
 *   docker stop productdb rabbitmq
 *   curl http://localhost:3002/health  # Still returns {"status":"ok"}
 */

const request = require('supertest');
const express = require('express');
const { Pool } = require('pg');

describe('IR-01: False Positive Health Check', () => {
  let app;
  let testPool;

  beforeAll(() => {
    testPool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'productdb',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '123',
      max: 2,
    });
  });

  afterAll(async () => {
    if (testPool) {
      await testPool.end();
    }
  });

  describe('Current Behavior (Vulnerable)', () => {
    test('VULNERABILITY: Health returns OK without checking anything', async () => {
      app = express();

      // Current implementation - no checks
      app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
      });

      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      // No DB check, no RabbitMQ check - false positive
    });

    test('VULNERABILITY: Health OK even with wrong DB config', async () => {
      app = express();

      // Simulate bad DB config
      const badPool = new Pool({
        host: 'non-existent-host',
        port: 5432,
        database: 'wrongdb',
        user: 'wrong',
        password: 'wrong',
        connectionTimeoutMillis: 1000,
      });

      // Current health endpoint doesn't use pool
      app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
      });

      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      // Health reports OK but DB is unreachable

      await badPool.end().catch(() => {});
    });

    test('VULNERABILITY: Health OK when RabbitMQ is down', async () => {
      app = express();

      let rabbitmqConnected = false; // Simulated RabbitMQ down

      // Current implementation ignores RabbitMQ state
      app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
      });

      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
      // RabbitMQ is down but health reports OK
    });
  });

  describe('What Health Check SHOULD Do', () => {
    test('EXPECTED: Proper health check verifies DB connection', async () => {
      app = express();

      app.get('/health', async (req, res) => {
        try {
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

    test('EXPECTED: Health fails when DB unreachable', async () => {
      const badPool = new Pool({
        host: 'localhost',
        port: 59999, // Wrong port
        database: 'productdb',
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

    test('EXPECTED: Health includes both DB and RabbitMQ status', async () => {
      let rabbitmqConnected = true;

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

      // Both healthy
      let response = await request(app).get('/health').expect(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.checks.db).toBe(true);
      expect(response.body.checks.rabbitmq).toBe(true);

      // RabbitMQ down
      rabbitmqConnected = false;
      response = await request(app).get('/health').expect(503);
      expect(response.body.status).toBe('unhealthy');
      expect(response.body.checks.rabbitmq).toBe(false);
    });
  });

  describe('Kubernetes Impact', () => {
    test('IMPACT: Liveness probe passes - pod stays running when broken', async () => {
      app = express();

      app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
      });

      const livenessCheck = async () => {
        const response = await request(app).get('/health');
        return response.status === 200;
      };

      const isAlive = await livenessCheck();
      expect(isAlive).toBe(true);
      // Pod won't be restarted even though dependencies are down
    });

    test('IMPACT: Readiness probe passes - traffic routed to broken pod', async () => {
      app = express();

      app.get('/health', (req, res) => {
        res.json({ status: 'ok' });
      });

      const readinessCheck = async () => {
        const response = await request(app).get('/health');
        return response.status === 200;
      };

      const isReady = await readinessCheck();
      expect(isReady).toBe(true);
      // Traffic will be sent to this pod even though it can't serve requests
    });
  });

  describe('Startup Probe Considerations', () => {
    test('EXPECTED: Separate startup probe for slow dependency init', async () => {
      let dbReady = false;
      let rabbitmqReady = false;

      app = express();

      // Startup probe - waits for all dependencies
      app.get('/startup', async (req, res) => {
        if (!dbReady || !rabbitmqReady) {
          return res.status(503).json({
            status: 'starting',
            db: dbReady,
            rabbitmq: rabbitmqReady,
          });
        }
        res.json({ status: 'started' });
      });

      // Initially not ready
      let response = await request(app).get('/startup').expect(503);
      expect(response.body.status).toBe('starting');

      // Simulate DB ready
      dbReady = true;
      response = await request(app).get('/startup').expect(503);

      // Simulate RabbitMQ ready
      rabbitmqReady = true;
      response = await request(app).get('/startup').expect(200);
      expect(response.body.status).toBe('started');
    });
  });
});

/**
 * REMEDIATION:
 * 
 * Replace simple health check with comprehensive dependency verification:
 * 
 * ```javascript
 * // index.js
 * const { pool } = require('./db');
 * 
 * // Track RabbitMQ state
 * let rabbitmqChannel = null;
 * 
 * // Comprehensive health check
 * app.get('/health', async (req, res) => {
 *   const checks = {
 *     db: false,
 *     rabbitmq: !!rabbitmqChannel,
 *   };
 * 
 *   // Check PostgreSQL
 *   try {
 *     const client = await pool.connect();
 *     await client.query('SELECT 1');
 *     client.release();
 *     checks.db = true;
 *   } catch (error) {
 *     console.error('[health] DB check failed:', error.message);
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
 * // Separate liveness (process running) vs readiness (can serve traffic)
 * app.get('/live', (req, res) => {
 *   res.json({ status: 'alive' });
 * });
 * 
 * app.get('/ready', async (req, res) => {
 *   // Same as /health
 * });
 * ```
 * 
 * Kubernetes config:
 * ```yaml
 * livenessProbe:
 *   httpGet:
 *     path: /live
 *     port: 3002
 *   initialDelaySeconds: 10
 *   periodSeconds: 10
 * 
 * readinessProbe:
 *   httpGet:
 *     path: /ready
 *     port: 3002
 *   initialDelaySeconds: 5
 *   periodSeconds: 5
 * ```
 */
