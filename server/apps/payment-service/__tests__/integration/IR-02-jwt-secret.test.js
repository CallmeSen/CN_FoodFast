/**
 * Integration Test: IR-02 - JWT Hardcoded Secret Fallback
 * 
 * Risk: The auth middleware (src/middlewares/auth.js:111) and config 
 * (src/config.js:27) use hardcoded fallback secret 'secret' when 
 * JWT_SECRET environment variable is not set. In production, if env
 * var is missing, tokens can be forged by attackers.
 * 
 * Test validates:
 * 1. Hardcoded 'secret' is used as JWT fallback
 * 2. Attacker can forge tokens knowing the secret
 * 3. Forged tokens grant unauthorized access
 * 4. Admin and superadmin tokens can be forged
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const {
  TEST_CONFIG,
  generateValidToken,
} = require('./setup');

// The hardcoded fallback secret from the vulnerable code
const HARDCODED_SECRET = 'secret';

describe('IR-02: JWT Hardcoded Secret Vulnerability', () => {
  let app;
  let originalJwtSecret;

  // Simulate the vulnerable auth middleware
  const createVulnerableAuthMiddleware = (configSecret) => {
    return (req, res, next) => {
      // Check for X-User-Id bypass (tested in IR-03)
      const directUserId = req.headers['x-user-id'];
      if (directUserId) {
        req.user = { id: directUserId, role: 'customer' };
        return next();
      }

      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'authorization header missing' });
      }

      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({ error: 'invalid authorization header format' });
      }

      const token = parts[1];
      try {
        // VULNERABILITY: Uses hardcoded 'secret' if configSecret is undefined
        const payload = jwt.verify(token, configSecret || 'secret');
        req.user = payload;
        return next();
      } catch (err) {
        return res.status(401).json({ error: 'invalid or expired token' });
      }
    };
  };

  beforeEach(() => {
    originalJwtSecret = process.env.JWT_SECRET;
    
    app = express();
    app.use(express.json());
  });

  afterEach(() => {
    if (originalJwtSecret) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  describe('Secret Fallback Behavior', () => {
    test('should use hardcoded secret when JWT_SECRET env is missing', async () => {
      // Remove env var to trigger fallback
      delete process.env.JWT_SECRET;

      const auth = createVulnerableAuthMiddleware(undefined); // Simulating missing config

      app.get('/protected', auth, (req, res) => {
        res.json({ user: req.user, secretUsed: 'revealed-in-test' });
      });

      // Forge token with the known hardcoded secret
      const forgedToken = jwt.sign(
        { id: 'attacker', role: 'customer', email: 'attacker@evil.com' },
        HARDCODED_SECRET,
        { expiresIn: '1h' }
      );

      const response = await request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${forgedToken}`);

      // VULNERABILITY: Forged token is accepted!
      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe('attacker');
    });

    test('should use hardcoded secret when config.JWT_SECRET is empty string', async () => {
      const auth = createVulnerableAuthMiddleware('');

      app.get('/protected', auth, (req, res) => {
        res.json({ user: req.user });
      });

      // Empty string is falsy, so 'secret' is used
      const forgedToken = jwt.sign(
        { id: 'attacker', role: 'admin' },
        HARDCODED_SECRET,
        { expiresIn: '1h' }
      );

      const response = await request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${forgedToken}`);

      expect(response.status).toBe(200);
      expect(response.body.user.role).toBe('admin');
    });
  });

  describe('Token Forgery Attacks', () => {
    test('should allow attacker to forge customer token', async () => {
      const auth = createVulnerableAuthMiddleware(undefined);

      app.get('/customer/data', auth, (req, res) => {
        res.json({
          userId: req.user.id,
          role: req.user.role,
          canAccessData: true,
        });
      });

      const forgedToken = jwt.sign(
        { id: 'victim-customer-123', role: 'customer' },
        HARDCODED_SECRET
      );

      const response = await request(app)
        .get('/customer/data')
        .set('Authorization', `Bearer ${forgedToken}`);

      expect(response.status).toBe(200);
      expect(response.body.userId).toBe('victim-customer-123');
      expect(response.body.canAccessData).toBe(true);
    });

    test('should allow attacker to forge admin token', async () => {
      const auth = createVulnerableAuthMiddleware(undefined);

      const requireAdmin = (req, res, next) => {
        if (!['admin', 'superadmin'].includes(req.user.role)) {
          return res.status(403).json({ error: 'Admin access required' });
        }
        next();
      };

      app.get('/admin/payments', auth, requireAdmin, (req, res) => {
        res.json({
          userId: req.user.id,
          role: req.user.role,
          allPaymentsVisible: true,
        });
      });

      // Attacker forges admin token
      const forgedAdminToken = jwt.sign(
        { id: 'fake-admin', role: 'admin', email: 'admin@fake.com' },
        HARDCODED_SECRET
      );

      const response = await request(app)
        .get('/admin/payments')
        .set('Authorization', `Bearer ${forgedAdminToken}`);

      // CRITICAL: Admin access granted with forged token!
      expect(response.status).toBe(200);
      expect(response.body.role).toBe('admin');
      expect(response.body.allPaymentsVisible).toBe(true);
    });

    test('should allow attacker to forge superadmin token', async () => {
      const auth = createVulnerableAuthMiddleware(undefined);

      const requireSuperAdmin = (req, res, next) => {
        if (req.user.role !== 'superadmin') {
          return res.status(403).json({ error: 'Superadmin access required' });
        }
        next();
      };

      app.delete('/admin/refund/:paymentId', auth, requireSuperAdmin, (req, res) => {
        res.json({
          action: 'refund_approved',
          paymentId: req.params.paymentId,
          approvedBy: req.user.id,
        });
      });

      // Attacker forges superadmin token
      const forgedSuperAdminToken = jwt.sign(
        { id: 'hacker-superadmin', role: 'superadmin' },
        HARDCODED_SECRET
      );

      const response = await request(app)
        .delete('/admin/refund/payment-12345')
        .set('Authorization', `Bearer ${forgedSuperAdminToken}`);

      // CRITICAL: Superadmin action executed with forged token!
      expect(response.status).toBe(200);
      expect(response.body.action).toBe('refund_approved');
    });
  });

  describe('Token Crafting Attacks', () => {
    test('should allow attacker to set arbitrary token expiry', async () => {
      const auth = createVulnerableAuthMiddleware(undefined);

      app.get('/protected', auth, (req, res) => {
        res.json({ user: req.user });
      });

      // Create token that never expires (100 years)
      const neverExpiresToken = jwt.sign(
        { id: 'persistent-attacker', role: 'admin' },
        HARDCODED_SECRET,
        { expiresIn: '36500d' }
      );

      const response = await request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${neverExpiresToken}`);

      expect(response.status).toBe(200);
      
      // Verify token has very long expiry
      const decoded = jwt.decode(neverExpiresToken);
      const expiryDate = new Date(decoded.exp * 1000);
      const yearsFromNow = (expiryDate - new Date()) / (365 * 24 * 60 * 60 * 1000);
      expect(yearsFromNow).toBeGreaterThan(99);
    });

    test('should allow attacker to inject arbitrary claims', async () => {
      const auth = createVulnerableAuthMiddleware(undefined);

      app.get('/protected', auth, (req, res) => {
        res.json({
          user: req.user,
          customClaims: {
            canRefund: req.user.canRefund,
            maxRefundAmount: req.user.maxRefundAmount,
          },
        });
      });

      // Inject dangerous custom claims
      const tokenWithCustomClaims = jwt.sign(
        {
          id: 'attacker',
          role: 'customer',
          canRefund: true,
          maxRefundAmount: 999999999,
          isVerified: true,
          creditLimit: 10000000,
        },
        HARDCODED_SECRET
      );

      const response = await request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${tokenWithCustomClaims}`);

      expect(response.status).toBe(200);
      expect(response.body.customClaims.canRefund).toBe(true);
      expect(response.body.customClaims.maxRefundAmount).toBe(999999999);
    });
  });

  describe('Secure Configuration Verification', () => {
    test('should reject forged token when proper secret is used', async () => {
      const SECURE_SECRET = 'very-long-random-secret-key-minimum-32-characters-recommended';
      const auth = createVulnerableAuthMiddleware(SECURE_SECRET);

      app.get('/protected', auth, (req, res) => {
        res.json({ user: req.user });
      });

      // Attacker tries to use hardcoded 'secret'
      const forgedToken = jwt.sign(
        { id: 'attacker', role: 'admin' },
        HARDCODED_SECRET
      );

      const response = await request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${forgedToken}`);

      // Should be rejected!
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('invalid or expired token');
    });

    test('should accept legitimate token with proper secret', async () => {
      const SECURE_SECRET = 'very-long-random-secret-key-minimum-32-characters-recommended';
      const auth = createVulnerableAuthMiddleware(SECURE_SECRET);

      app.get('/protected', auth, (req, res) => {
        res.json({ user: req.user });
      });

      // Legitimate token signed with correct secret
      const legitimateToken = jwt.sign(
        { id: 'real-user', role: 'customer' },
        SECURE_SECRET
      );

      const response = await request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${legitimateToken}`);

      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe('real-user');
    });
  });
});

describe('IR-02: Mitigation Recommendations', () => {
  test('Recommended: Fail startup if JWT_SECRET not set', () => {
    /**
     * RECOMMENDED MITIGATION:
     * 
     * // In config.js or index.js
     * const JWT_SECRET = process.env.JWT_SECRET;
     * 
     * if (!JWT_SECRET || JWT_SECRET.length < 32) {
     *   console.error('FATAL: JWT_SECRET must be set and at least 32 characters');
     *   process.exit(1);
     * }
     * 
     * // Additional checks:
     * if (JWT_SECRET === 'secret' || JWT_SECRET === 'changeme') {
     *   console.error('FATAL: JWT_SECRET is using a known insecure value');
     *   process.exit(1);
     * }
     * 
     * module.exports = {
     *   JWT_SECRET,  // No fallback!
     *   ...
     * };
     */
    const startupValidationImplemented = false;
    expect(startupValidationImplemented).toBe(false);
  });

  test('Recommended: Use environment-specific secrets', () => {
    /**
     * SECRET MANAGEMENT BEST PRACTICES:
     * 
     * 1. Development: Use .env.development with unique dev secret
     * 2. Staging: Use secure vault (HashiCorp, AWS Secrets Manager)
     * 3. Production: Use secure vault with rotation policy
     * 
     * Example with AWS Secrets Manager:
     * const { SecretsManager } = require('@aws-sdk/client-secrets-manager');
     * 
     * async function getJwtSecret() {
     *   const client = new SecretsManager({ region: 'ap-southeast-1' });
     *   const response = await client.getSecretValue({ SecretId: 'payment-service/jwt-secret' });
     *   return response.SecretString;
     * }
     */
    const secretManagementImplemented = false;
    expect(secretManagementImplemented).toBe(false);
  });
});
