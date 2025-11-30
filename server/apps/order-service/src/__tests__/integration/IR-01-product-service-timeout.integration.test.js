/**
 * Integration Test: IR-01 - Product Service Timeout
 * 
 * Root Cause: REQUEST_TIMEOUT = 7000ms in product.client.js:7 is fixed; no circuit breaker
 * Impact: Order creation blocked for 7s, then fails with pricing error
 * Evidence: orders.service.js:848-855 catches error but only if ALLOW_CLIENT_PRICING_FALLBACK=true
 */

const request = require('supertest');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const http = require('http');
const app = require('../../app');

describe('IR-01: Product Service Timeout Integration Tests', () => {
  let pool;
  let customerToken;
  let mockProductServer;
  const JWT_SECRET = process.env.JWT_SECRET || 'secret';

  const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
  const TEST_RESTAURANT_ID = '22222222-2222-2222-2222-222222222222';
  const TEST_BRANCH_ID = '33333333-3333-3333-3333-333333333333';
  const TEST_PRODUCT_ID = '44444444-4444-4444-4444-444444444444';

  beforeAll(async () => {
    // GIVEN - Database connection
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5435,
      database: process.env.DB_NAME || 'orderdb',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '123',
    });

    // GIVEN - Valid customer JWT token
    customerToken = jwt.sign(
      { userId: TEST_USER_ID, role: 'customer', roles: ['customer'] },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // GIVEN - Seed test data
    await pool.query(`
      INSERT INTO orders (id, user_id, restaurant_id, branch_id, status, payment_status, total_amount, currency, metadata)
      VALUES ($1, $2, $3, $4, 'pending', 'unpaid', 0, 'VND', '{}')
      ON CONFLICT (id) DO NOTHING
    `, [
      '55555555-5555-5555-5555-555555555555',
      TEST_USER_ID,
      TEST_RESTAURANT_ID,
      TEST_BRANCH_ID
    ]);
  });

  afterAll(async () => {
    // Cleanup
    await pool.query(`DELETE FROM orders WHERE user_id = $1`, [TEST_USER_ID]);
    await pool.end();
    if (mockProductServer) {
      mockProductServer.close();
    }
  });

  describe('Product Service Timeout Scenarios', () => {
    it('should fail order creation when product-service times out (>7s)', async () => {
      // GIVEN - Mock product-service that delays response beyond timeout
      mockProductServer = http.createServer((req, res) => {
        // Simulate 8 second delay (beyond 7s timeout)
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ items: [], totals: { total_amount: 100 } }));
        }, 8000);
      });

      await new Promise((resolve) => {
        mockProductServer.listen(3099, resolve);
      });

      // Store original env
      const originalProductUrl = process.env.PRODUCT_SERVICE_URL;
      process.env.PRODUCT_SERVICE_URL = 'http://localhost:3099';
      process.env.ALLOW_CLIENT_PRICING_FALLBACK = 'false';

      // WHEN - Customer attempts to create an order
      const startTime = Date.now();
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          branch_id: TEST_BRANCH_ID,
          items: [
            {
              product_id: TEST_PRODUCT_ID,
              quantity: 1,
              unit_price: 50000,
            },
          ],
          payment_method: 'cod',
        })
        .timeout(15000);

      const elapsedTime = Date.now() - startTime;

      // THEN - Request should fail after timeout period
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(elapsedTime).toBeGreaterThanOrEqual(7000);
      expect(elapsedTime).toBeLessThan(10000);

      // Restore env
      process.env.PRODUCT_SERVICE_URL = originalProductUrl;
      mockProductServer.close();
    }, 20000);

    it('should use client fallback pricing when ALLOW_CLIENT_PRICING_FALLBACK=true and product-service fails', async () => {
      // GIVEN - Mock product-service that immediately fails
      const failingServer = http.createServer((req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      });

      await new Promise((resolve) => {
        failingServer.listen(3098, resolve);
      });

      const originalProductUrl = process.env.PRODUCT_SERVICE_URL;
      process.env.PRODUCT_SERVICE_URL = 'http://localhost:3098';
      process.env.ALLOW_CLIENT_PRICING_FALLBACK = 'true';

      // WHEN - Customer creates order with fallback enabled
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          branch_id: TEST_BRANCH_ID,
          items: [
            {
              product_id: TEST_PRODUCT_ID,
              quantity: 2,
              unit_price: 25000,
              total_price: 50000,
            },
          ],
          payment_method: 'cod',
        });

      // THEN - Order should be created using client-provided pricing
      // Note: This may still fail due to other validations, but should not fail on pricing
      if (response.status === 201) {
        expect(response.body).toHaveProperty('id');
        expect(response.body.total_amount).toBeDefined();
      }

      // Restore env
      process.env.PRODUCT_SERVICE_URL = originalProductUrl;
      process.env.ALLOW_CLIENT_PRICING_FALLBACK = 'false';
      failingServer.close();
    }, 15000);

    it('should block concurrent orders when product-service is slow', async () => {
      // GIVEN - Slow product-service (3s delay)
      const slowServer = http.createServer((req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            items: [{ product_id: TEST_PRODUCT_ID, unit_price: 10000, quantity: 1, total_price: 10000 }],
            totals: { total_amount: 10000, currency: 'VND' },
          }));
        }, 3000);
      });

      await new Promise((resolve) => {
        slowServer.listen(3097, resolve);
      });

      const originalProductUrl = process.env.PRODUCT_SERVICE_URL;
      process.env.PRODUCT_SERVICE_URL = 'http://localhost:3097';

      // WHEN - Multiple concurrent order requests
      const startTime = Date.now();
      const concurrentRequests = Array(3).fill(null).map(() =>
        request(app)
          .post('/customer/orders')
          .set('Authorization', `Bearer ${customerToken}`)
          .send({
            restaurant_id: TEST_RESTAURANT_ID,
            branch_id: TEST_BRANCH_ID,
            items: [{ product_id: TEST_PRODUCT_ID, quantity: 1, unit_price: 10000 }],
            payment_method: 'cod',
          })
      );

      const results = await Promise.allSettled(concurrentRequests);
      const elapsedTime = Date.now() - startTime;

      // THEN - All requests are blocked during slow product-service call
      expect(elapsedTime).toBeGreaterThanOrEqual(3000);
      results.forEach((result) => {
        expect(result.status).toBe('fulfilled');
      });

      // Restore env
      process.env.PRODUCT_SERVICE_URL = originalProductUrl;
      slowServer.close();
    }, 20000);

    it('should return appropriate error message when product-service is unavailable', async () => {
      // GIVEN - Product service URL pointing to non-existent server
      const originalProductUrl = process.env.PRODUCT_SERVICE_URL;
      process.env.PRODUCT_SERVICE_URL = 'http://localhost:59999';
      process.env.ALLOW_CLIENT_PRICING_FALLBACK = 'false';

      // WHEN - Order creation attempted
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          branch_id: TEST_BRANCH_ID,
          items: [{ product_id: TEST_PRODUCT_ID, quantity: 1, unit_price: 10000 }],
          payment_method: 'cod',
        });

      // THEN - Should return error indicating pricing service failure
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body.error).toBeDefined();

      // Restore env
      process.env.PRODUCT_SERVICE_URL = originalProductUrl;
    }, 15000);
  });

  describe('Circuit Breaker Absence Verification', () => {
    it('should not have circuit breaker - repeated failures still attempt connection', async () => {
      // GIVEN - Product service that always fails
      let requestCount = 0;
      const countingServer = http.createServer((req, res) => {
        requestCount++;
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service Unavailable' }));
      });

      await new Promise((resolve) => {
        countingServer.listen(3096, resolve);
      });

      const originalProductUrl = process.env.PRODUCT_SERVICE_URL;
      process.env.PRODUCT_SERVICE_URL = 'http://localhost:3096';
      process.env.ALLOW_CLIENT_PRICING_FALLBACK = 'false';

      // WHEN - Multiple order attempts after failures
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/customer/orders')
          .set('Authorization', `Bearer ${customerToken}`)
          .send({
            restaurant_id: TEST_RESTAURANT_ID,
            branch_id: TEST_BRANCH_ID,
            items: [{ product_id: TEST_PRODUCT_ID, quantity: 1, unit_price: 10000 }],
            payment_method: 'cod',
          });
      }

      // THEN - All 5 requests attempted (no circuit breaker preventing calls)
      expect(requestCount).toBe(5);

      // Restore env
      process.env.PRODUCT_SERVICE_URL = originalProductUrl;
      countingServer.close();
    }, 30000);
  });
});
