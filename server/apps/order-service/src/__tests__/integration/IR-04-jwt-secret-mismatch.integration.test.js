/**
 * Integration Test: IR-04 - JWT Secret Mismatch
 * 
 * Root Cause: Fallback JWT_SECRET: 'secret' in config.js:14 used if env var missing
 * Impact: api-gateway signs tokens that order-service rejects (401)
 * Evidence: middleware/auth.js:16 uses config.JWT_SECRET || 'secret' - double fallback
 */

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../app');
const config = require('../../config');

describe('IR-04: JWT Secret Mismatch Integration Tests', () => {
  const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
  const TEST_RESTAURANT_ID = '22222222-2222-2222-2222-222222222222';

  describe('JWT Secret Configuration Vulnerability', () => {
    it('should expose default JWT_SECRET fallback in config', () => {
      // GIVEN - config.js has fallback: JWT_SECRET: process.env.JWT_SECRET || 'secret'

      // WHEN - JWT_SECRET env var is not set
      const originalSecret = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;

      // Force reload config to test fallback
      jest.resetModules();
      const freshConfig = require('../../config');

      // THEN - Config should use 'secret' as fallback
      expect(freshConfig.JWT_SECRET).toBe('secret');

      // Restore
      if (originalSecret) {
        process.env.JWT_SECRET = originalSecret;
      }
    });

    it('should reject tokens signed with different secret', async () => {
      // GIVEN - Token signed with different secret (simulating api-gateway mismatch)
      const differentSecret = 'api-gateway-different-secret';
      const mismatchedToken = jwt.sign(
        { userId: TEST_USER_ID, role: 'customer', roles: ['customer'] },
        differentSecret,
        { expiresIn: '1h' }
      );

      // WHEN - Request with mismatched token
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${mismatchedToken}`)
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          items: [{ product_id: 'test', quantity: 1 }],
        });

      // THEN - Should return 401 Unauthorized
      expect(response.status).toBe(401);
      expect(response.body.message).toMatch(/invalid|expired|token/i);
    });

    it('should accept tokens signed with matching secret', async () => {
      // GIVEN - Token signed with correct secret
      const correctSecret = config.JWT_SECRET;
      const validToken = jwt.sign(
        { userId: TEST_USER_ID, role: 'customer', roles: ['customer'] },
        correctSecret,
        { expiresIn: '1h' }
      );

      // WHEN - Request with valid token
      const response = await request(app)
        .get('/customer/orders')
        .set('Authorization', `Bearer ${validToken}`);

      // THEN - Should not return 401 (may be 200 or other business error)
      expect(response.status).not.toBe(401);
    });

    it('should reject tokens signed with fallback secret when env var is set', async () => {
      // GIVEN - Env var is set to specific secret
      const originalSecret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'production-secret-from-env';

      // Force reload
      jest.resetModules();
      const freshApp = require('../../app');

      // Token signed with fallback 'secret' (old/misconfigured api-gateway)
      const fallbackToken = jwt.sign(
        { userId: TEST_USER_ID, role: 'customer', roles: ['customer'] },
        'secret', // Fallback value
        { expiresIn: '1h' }
      );

      // WHEN - Request with token signed using fallback
      const response = await request(freshApp)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${fallbackToken}`)
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          items: [{ product_id: 'test', quantity: 1 }],
        });

      // THEN - Should reject with 401
      expect(response.status).toBe(401);

      // Restore
      process.env.JWT_SECRET = originalSecret;
    });
  });

  describe('Authorization Header Validation', () => {
    it('should reject request without Authorization header', async () => {
      // GIVEN - No Authorization header

      // WHEN - Request without token
      const response = await request(app)
        .post('/customer/orders')
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          items: [{ product_id: 'test', quantity: 1 }],
        });

      // THEN - Should return 401
      expect(response.status).toBe(401);
      expect(response.body.message).toMatch(/authorization|header|missing/i);
    });

    it('should reject malformed Authorization header', async () => {
      // GIVEN - Malformed Authorization header (no Bearer prefix)
      const token = jwt.sign(
        { userId: TEST_USER_ID, role: 'customer' },
        config.JWT_SECRET,
        { expiresIn: '1h' }
      );

      // WHEN - Request with malformed header
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', token) // Missing "Bearer " prefix
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          items: [{ product_id: 'test', quantity: 1 }],
        });

      // THEN - Should return 401
      expect(response.status).toBe(401);
    });

    it('should reject empty Bearer token', async () => {
      // GIVEN - Empty Bearer token

      // WHEN - Request with empty token
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', 'Bearer ')
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          items: [{ product_id: 'test', quantity: 1 }],
        });

      // THEN - Should return 401
      expect(response.status).toBe(401);
    });

    it('should reject expired tokens', async () => {
      // GIVEN - Expired token
      const expiredToken = jwt.sign(
        { userId: TEST_USER_ID, role: 'customer', roles: ['customer'] },
        config.JWT_SECRET,
        { expiresIn: '-1h' } // Already expired
      );

      // WHEN - Request with expired token
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${expiredToken}`)
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          items: [{ product_id: 'test', quantity: 1 }],
        });

      // THEN - Should return 401
      expect(response.status).toBe(401);
      expect(response.body.message).toMatch(/invalid|expired|token/i);
    });
  });

  describe('Token Payload Validation', () => {
    it('should reject token without userId', async () => {
      // GIVEN - Token without userId
      const tokenWithoutUserId = jwt.sign(
        { role: 'customer', roles: ['customer'] }, // No userId
        config.JWT_SECRET,
        { expiresIn: '1h' }
      );

      // WHEN - Request with invalid token payload
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${tokenWithoutUserId}`)
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          items: [{ product_id: 'test', quantity: 1 }],
        });

      // THEN - Should fail (either 401 or 400 depending on where validation happens)
      expect([400, 401, 403]).toContain(response.status);
    });

    it('should reject token with wrong role for customer endpoint', async () => {
      // GIVEN - Token with owner role (not customer)
      const ownerToken = jwt.sign(
        { userId: TEST_USER_ID, role: 'owner', roles: ['owner'] },
        config.JWT_SECRET,
        { expiresIn: '1h' }
      );

      // WHEN - Request to customer endpoint with owner token
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          items: [{ product_id: 'test', quantity: 1 }],
        });

      // THEN - Should return 403 Forbidden (wrong role)
      expect(response.status).toBe(403);
    });
  });

  describe('Cross-Service JWT Compatibility', () => {
    it('should document JWT secret configuration requirement', () => {
      // GIVEN - Config file at config.js:14
      // const JWT_SECRET = process.env.JWT_SECRET || 'secret';

      // THEN - Document the risk
      const riskDocumentation = {
        file: 'config.js',
        line: 14,
        code: "JWT_SECRET: process.env.JWT_SECRET || 'secret'",
        risk: 'If JWT_SECRET env var is not set in order-service but IS set in api-gateway, all tokens will be rejected',
        mitigation: 'Ensure JWT_SECRET is explicitly set in all services',
      };

      expect(riskDocumentation.risk).toBeDefined();
      console.log('JWT Secret Mismatch Risk:', JSON.stringify(riskDocumentation, null, 2));
    });

    it('should verify both services need same JWT_SECRET', async () => {
      // GIVEN - Simulated api-gateway secret vs order-service secret
      const apiGatewaySecret = 'api-gateway-prod-secret';
      const orderServiceSecret = config.JWT_SECRET;

      // WHEN - Secrets are compared
      const secretsMatch = apiGatewaySecret === orderServiceSecret;

      // THEN - If they don't match, document the failure mode
      if (!secretsMatch) {
        console.log('WARNING: JWT secrets do not match!');
        console.log('API Gateway would sign:', apiGatewaySecret.substring(0, 5) + '...');
        console.log('Order Service expects:', orderServiceSecret.substring(0, 5) + '...');

        // Demonstrate rejection
        const gatewaySignedToken = jwt.sign(
          { userId: TEST_USER_ID, role: 'customer', roles: ['customer'] },
          apiGatewaySecret,
          { expiresIn: '1h' }
        );

        const response = await request(app)
          .get('/customer/orders')
          .set('Authorization', `Bearer ${gatewaySignedToken}`);

        expect(response.status).toBe(401);
      }
    });
  });
});
