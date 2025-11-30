/**
 * Integration Test: IR-05 - X-User-Id Header Bypass Authentication
 * 
 * Risk: customer.routes.js:10-13 allows bypassing JWT authentication
 *       by simply sending X-User-Id header
 * 
 * Impact: CRITICAL - Attacker can access ANY user's data without authentication
 * 
 * Target Code (customer.routes.js:10-13):
 * ```javascript
 * const directUserId = req.headers['x-user-id'] || req.query?.user_id || req.body?.user_id;
 * if (directUserId) {
 *   req.user = { userId: directUserId, role: 'customer' };
 *   return next();
 * }
 * ```
 * 
 * Reproduction:
 *   curl -H "X-User-Id: 1" http://localhost:3001/api/customers/me/addresses
 */

const request = require('supertest');
const express = require('express');

describe('IR-05: X-User-Id Header Bypass Authentication', () => {
  let app;
  let mockAddressRepository;
  
  beforeEach(() => {
    jest.resetModules();
    
    // Mock address repository
    mockAddressRepository = {
      listByUserId: jest.fn().mockResolvedValue([
        { id: 1, street: '123 Secret St', city: 'Private City' },
        { id: 2, street: '456 Hidden Ave', city: 'Confidential Town' },
      ]),
    };
    
    // Mock the repositories
    jest.doMock('../../repositories/address.repository', () => mockAddressRepository);
    
    // Create minimal app with customer routes
    app = express();
    app.use(express.json());
    
    // Import the actual routes (with the vulnerability)
    const customerRoutes = require('../../routes/customer.routes');
    app.use('/api/customers', customerRoutes);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('VULNERABILITY: X-User-Id header bypasses JWT authentication completely', async () => {
    // Attacker sends X-User-Id header WITHOUT any JWT token
    const response = await request(app)
      .get('/api/customers/me/addresses')
      .set('X-User-Id', '999') // Arbitrary user ID
      // NO Authorization header!
      .expect(200);

    // Attack succeeds - got addresses without authentication
    expect(response.body).toBeDefined();
    
    // Repository was called with attacker-specified user ID
    expect(mockAddressRepository.listByUserId).toHaveBeenCalledWith('999');
  });

  test('VULNERABILITY: user_id query param also bypasses authentication', async () => {
    const response = await request(app)
      .get('/api/customers/me/addresses')
      .query({ user_id: '888' })
      .expect(200);

    expect(mockAddressRepository.listByUserId).toHaveBeenCalledWith('888');
  });

  test('VULNERABILITY: user_id in body bypasses authentication (POST routes)', async () => {
    // Mock createAddress for this test
    mockAddressRepository.createAddress = jest.fn().mockResolvedValue({
      id: 999,
      street: 'Malicious Street',
    });

    const response = await request(app)
      .post('/api/customers/me/addresses')
      .send({
        user_id: '777', // Bypass auth
        street: 'Malicious Street',
        city: 'Hack City',
      })
      .expect(201);

    // Attacker can create addresses for ANY user
    expect(response.body).toBeDefined();
  });

  test('EXPECTED: Without bypass header, request should be rejected', async () => {
    const response = await request(app)
      .get('/api/customers/me/addresses')
      // No X-User-Id, no user_id, no Authorization
      .expect(401);

    expect(response.body.message).toBe('Unauthorized');
  });

  test('ATTACK SCENARIO: Enumerate user addresses via ID iteration', async () => {
    const stolenData = [];

    // Attacker iterates through user IDs
    for (let userId = 1; userId <= 3; userId++) {
      mockAddressRepository.listByUserId.mockResolvedValueOnce([
        { id: userId * 10, street: `Address for user ${userId}` },
      ]);

      const response = await request(app)
        .get('/api/customers/me/addresses')
        .set('X-User-Id', String(userId));

      if (response.status === 200) {
        stolenData.push({ userId, addresses: response.body });
      }
    }

    // Attacker successfully enumerated all users' addresses
    expect(stolenData.length).toBe(3);
    expect(mockAddressRepository.listByUserId).toHaveBeenCalledTimes(3);
  });
});

/**
 * REMEDIATION:
 * 
 * The X-User-Id header should ONLY be trusted from internal services.
 * 
 * Option 1: Remove the bypass entirely for external-facing routes
 * Option 2: Add IP-based or service-mesh validation
 * Option 3: Use API Gateway to strip X-User-Id from external requests
 * 
 * ```javascript
 * // FIXED VERSION
 * function authMiddleware(req, res, next) {
 *   // Only trust X-User-Id from internal network
 *   const isInternalRequest = req.headers['x-internal-service-key'] === process.env.INTERNAL_SERVICE_KEY;
 *   
 *   if (isInternalRequest) {
 *     const directUserId = req.headers['x-user-id'];
 *     if (directUserId) {
 *       req.user = { userId: directUserId, role: 'customer' };
 *       return next();
 *     }
 *   }
 *   
 *   // Otherwise, require JWT
 *   const header = req.headers.authorization;
 *   // ... existing JWT validation ...
 * }
 * ```
 */
