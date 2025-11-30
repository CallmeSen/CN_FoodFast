/**
 * Integration Test: IR-03 - JWT Secret Hardcoded Fallback
 * 
 * Risk: config.js:10 and customer.routes.js:6 use fallback 'secret'
 *       when JWT_SECRET environment variable is not set
 * 
 * Impact: HIGH - Attackers can forge valid JWT tokens in production
 * 
 * Target Code:
 *   config.js:10 - JWT_SECRET: process.env.JWT_SECRET || 'secret'
 *   customer.routes.js:6 - const JWT_SECRET = process.env.JWT_SECRET || 'secret';
 *   middlewares/auth.js:19 - jwt.verify(token, config.JWT_SECRET || 'secret')
 * 
 * Reproduction:
 *   # Forge a token with the known secret
 *   node -e "console.log(require('jsonwebtoken').sign({userId:1,role:'customer'},'secret',{expiresIn:'1h'}))"
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

describe('IR-03: JWT Secret Hardcoded Fallback to "secret"', () => {
  const HARDCODED_SECRET = 'secret';
  let app;
  let originalJwtSecret;
  let mockAddressRepository;

  beforeAll(() => {
    // Save original env
    originalJwtSecret = process.env.JWT_SECRET;
  });

  afterAll(() => {
    // Restore original env
    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  beforeEach(() => {
    jest.resetModules();
    
    // IMPORTANT: Remove JWT_SECRET to trigger fallback
    delete process.env.JWT_SECRET;
    
    mockAddressRepository = {
      listByUserId: jest.fn().mockResolvedValue([
        { id: 1, street: '123 Real St' },
      ]),
    };
    
    jest.doMock('../../repositories/address.repository', () => mockAddressRepository);
    
    app = express();
    app.use(express.json());
    
    const customerRoutes = require('../../routes/customer.routes');
    app.use('/api/customers', customerRoutes);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('VULNERABILITY: Forged token with hardcoded secret is accepted', async () => {
    // Attacker forges a token using the well-known secret
    const forgedToken = jwt.sign(
      { userId: 999, role: 'customer' },
      HARDCODED_SECRET,
      { expiresIn: '1h' }
    );

    const response = await request(app)
      .get('/api/customers/me/addresses')
      .set('Authorization', `Bearer ${forgedToken}`)
      .expect(200);

    // Forged token was accepted!
    expect(mockAddressRepository.listByUserId).toHaveBeenCalledWith(999);
  });

  test('VULNERABILITY: Attacker can impersonate any user', async () => {
    const targetUserId = 12345; // Any user ID attacker wants to impersonate
    
    const forgedToken = jwt.sign(
      { userId: targetUserId, role: 'customer' },
      HARDCODED_SECRET,
      { expiresIn: '24h' }
    );

    const response = await request(app)
      .get('/api/customers/me/addresses')
      .set('Authorization', `Bearer ${forgedToken}`)
      .expect(200);

    expect(mockAddressRepository.listByUserId).toHaveBeenCalledWith(targetUserId);
  });

  test('VULNERABILITY: Token with different role still works', async () => {
    // Attacker claims to be admin (though route doesn't check role)
    const forgedToken = jwt.sign(
      { userId: 1, role: 'admin' },
      HARDCODED_SECRET,
      { expiresIn: '1h' }
    );

    const response = await request(app)
      .get('/api/customers/me/addresses')
      .set('Authorization', `Bearer ${forgedToken}`)
      .expect(200);

    expect(mockAddressRepository.listByUserId).toHaveBeenCalled();
  });

  test('Token with wrong secret is rejected', async () => {
    // This should fail - using a different secret
    const wrongSecretToken = jwt.sign(
      { userId: 1, role: 'customer' },
      'different-secret',
      { expiresIn: '1h' }
    );

    const response = await request(app)
      .get('/api/customers/me/addresses')
      .set('Authorization', `Bearer ${wrongSecretToken}`)
      .expect(401);

    expect(response.body.message).toBe('Unauthorized');
    expect(mockAddressRepository.listByUserId).not.toHaveBeenCalled();
  });

  test('SECURITY: When JWT_SECRET is set, hardcoded secret fails', async () => {
    // Set a proper secret
    process.env.JWT_SECRET = 'my-super-secure-production-secret-256-bits';
    
    // Clear module cache to pick up new env
    jest.resetModules();
    
    // Recreate app with new config
    const newApp = express();
    newApp.use(express.json());
    const freshRoutes = require('../../routes/customer.routes');
    newApp.use('/api/customers', freshRoutes);

    // Attacker's token with hardcoded secret should fail now
    const forgedToken = jwt.sign(
      { userId: 999, role: 'customer' },
      HARDCODED_SECRET, // Using the old hardcoded secret
      { expiresIn: '1h' }
    );

    const response = await request(newApp)
      .get('/api/customers/me/addresses')
      .set('Authorization', `Bearer ${forgedToken}`)
      .expect(401);

    expect(response.body.message).toBe('Unauthorized');
  });

  test('ATTACK SCENARIO: Attacker creates permanent admin token', async () => {
    // Attacker creates a token that never expires
    const permanentToken = jwt.sign(
      { userId: 1, role: 'admin', isAdmin: true },
      HARDCODED_SECRET
      // No expiresIn - token lasts forever!
    );

    const decoded = jwt.decode(permanentToken);
    
    // Token has no expiration
    expect(decoded.exp).toBeUndefined();
    expect(decoded.userId).toBe(1);
    expect(decoded.role).toBe('admin');
    
    // And it's accepted by the server
    const response = await request(app)
      .get('/api/customers/me/addresses')
      .set('Authorization', `Bearer ${permanentToken}`)
      .expect(200);
  });
});

/**
 * REMEDIATION:
 * 
 * 1. NEVER use hardcoded fallback secrets
 * 2. Fail fast if JWT_SECRET is not configured
 * 3. Use cryptographically secure random secrets
 * 
 * ```javascript
 * // config.js - FIXED VERSION
 * if (!process.env.JWT_SECRET) {
 *   throw new Error('JWT_SECRET environment variable is required');
 * }
 * 
 * if (process.env.JWT_SECRET.length < 32) {
 *   throw new Error('JWT_SECRET must be at least 32 characters');
 * }
 * 
 * module.exports = {
 *   PORT: process.env.PORT || 3001,
 *   DB: { ... },
 *   JWT_SECRET: process.env.JWT_SECRET, // No fallback!
 * };
 * ```
 * 
 * Generate secure secret:
 *   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
 */
