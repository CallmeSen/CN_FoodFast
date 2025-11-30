/**
 * Integration Test: IR-03 - X-User-Id Header Bypass Vulnerability
 * 
 * Risk: The auth middleware (src/middlewares/auth.js:54-88) allows authentication
 * bypass when X-User-Id header is present. Attackers can impersonate any user
 * for payment operations without providing a valid JWT.
 * 
 * Test validates:
 * 1. X-User-Id header bypasses JWT verification
 * 2. Attacker can impersonate arbitrary users
 * 3. Sensitive payment operations are accessible via header injection
 * 4. Role escalation via X-User-Role header
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const {
  TEST_CONFIG,
  generateValidToken,
  createTestApp,
} = require('./setup');

// Import the actual auth middleware for testing
const authMiddleware = require('../../src/middlewares/auth');

describe('IR-03: X-User-Id Header Authentication Bypass', () => {
  let app;

  beforeEach(() => {
    // Create test app with auth middleware
    app = express();
    app.use(express.json());

    // Protected route that requires authentication
    app.get('/customer/payment-methods', authMiddleware, (req, res) => {
      res.json({
        user: req.user,
        message: 'Payment methods accessed',
      });
    });

    // Simulate payment action
    app.post('/customer/payment', authMiddleware, (req, res) => {
      res.json({
        user: req.user,
        action: 'payment_initiated',
        amount: req.body.amount,
      });
    });

    // Admin route
    app.get('/admin/payments', authMiddleware, (req, res) => {
      res.json({
        user: req.user,
        role: req.user.role,
        isAdmin: ['admin', 'superadmin'].includes(req.user.role),
      });
    });
  });

  describe('Header Injection Attacks', () => {
    test('should allow access with X-User-Id header without JWT', async () => {
      // VULNERABILITY: No JWT required when X-User-Id is present
      const response = await request(app)
        .get('/customer/payment-methods')
        .set('X-User-Id', 'victim-user-id-123');

      // This SHOULD fail (401) but the vulnerable code allows it
      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe('victim-user-id-123');
    });

    test('should allow impersonation of any user ID', async () => {
      const victimUserId = 'real-customer-uuid-456';
      
      const response = await request(app)
        .post('/customer/payment')
        .set('X-User-Id', victimUserId)
        .send({ amount: 1000000 });

      expect(response.status).toBe(200);
      expect(response.body.user.userId).toBe(victimUserId);
      expect(response.body.action).toBe('payment_initiated');
    });

    test('should allow role escalation via X-User-Role header', async () => {
      const response = await request(app)
        .get('/admin/payments')
        .set('X-User-Id', 'attacker-id')
        .set('X-User-Role', 'superadmin');

      expect(response.status).toBe(200);
      expect(response.body.user.role).toBe('superadmin');
      expect(response.body.isAdmin).toBe(true);
    });

    test('should accept multiple roles via X-User-Roles header', async () => {
      const response = await request(app)
        .get('/admin/payments')
        .set('X-User-Id', 'attacker-id')
        .set('X-User-Roles', 'admin,superadmin,customer');

      expect(response.status).toBe(200);
      expect(response.body.user.roles).toContain('admin');
      expect(response.body.user.roles).toContain('superadmin');
    });
  });

  describe('Header Injection via Request Body', () => {
    test('should accept user_id from request body', async () => {
      const response = await request(app)
        .post('/customer/payment')
        .send({
          user_id: 'body-injected-user-id',
          amount: 50000,
        });

      // Vulnerability: user_id in body can bypass auth
      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe('body-injected-user-id');
    });

    test('should accept role from request body', async () => {
      const response = await request(app)
        .post('/customer/payment')
        .send({
          user_id: 'attacker-id',
          role: 'superadmin',
          amount: 100000,
        });

      expect(response.status).toBe(200);
      expect(response.body.user.role).toBe('superadmin');
    });
  });

  describe('Comparison with Valid JWT Auth', () => {
    test('should require valid JWT when no X-User-Id header', async () => {
      // Without X-User-Id or JWT, should fail
      const response = await request(app)
        .get('/customer/payment-methods');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('authorization header missing');
    });

    test('should validate JWT when provided', async () => {
      const token = generateValidToken({ id: 'jwt-user-id', role: 'customer' });

      const response = await request(app)
        .get('/customer/payment-methods')
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe('jwt-user-id');
    });

    test('X-User-Id header takes precedence over JWT', async () => {
      const token = generateValidToken({ id: 'jwt-user-id', role: 'customer' });

      const response = await request(app)
        .get('/customer/payment-methods')
        .set('Authorization', `Bearer ${token}`)
        .set('X-User-Id', 'header-user-id');

      // Header takes precedence - dangerous behavior
      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe('header-user-id');
    });
  });

  describe('Injection via Query Parameters', () => {
    test('should accept user_id from query string', async () => {
      const response = await request(app)
        .get('/customer/payment-methods?user_id=query-injected-user');

      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe('query-injected-user');
    });

    test('should accept role from query string', async () => {
      const response = await request(app)
        .get('/customer/payment-methods?user_id=attacker&role=admin');

      expect(response.status).toBe(200);
      expect(response.body.user.role).toBe('admin');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty X-User-Id (fallback to JWT check)', async () => {
      const response = await request(app)
        .get('/customer/payment-methods')
        .set('X-User-Id', '   ');

      // Empty/whitespace should trigger JWT check
      expect(response.status).toBe(401);
    });

    test('should handle JSON array in X-User-Roles header', async () => {
      const response = await request(app)
        .get('/admin/payments')
        .set('X-User-Id', 'attacker')
        .set('X-User-Roles', '["admin","superadmin"]');

      expect(response.status).toBe(200);
      expect(response.body.user.roles).toContain('admin');
    });

    test('should default to customer role when no role specified', async () => {
      const response = await request(app)
        .get('/customer/payment-methods')
        .set('X-User-Id', 'some-user');

      expect(response.status).toBe(200);
      expect(response.body.user.role).toBe('customer');
    });
  });
});

describe('IR-03: Mitigation Recommendations', () => {
  test('Recommended: Reject X-User-Id header in production', () => {
    /**
     * MITIGATION: The X-User-Id header pattern is useful for internal
     * service-to-service communication (after API gateway auth),
     * but should NEVER be exposed to external clients.
     * 
     * Options:
     * 1. Remove X-User-Id support entirely
     * 2. Only accept X-User-Id from trusted internal IPs
     * 3. Require a shared service secret alongside X-User-Id
     * 4. Use mutual TLS for service-to-service auth
     */
    const mitigationApplied = false; // Set to true when fixed
    expect(mitigationApplied).toBe(false);
  });
});
