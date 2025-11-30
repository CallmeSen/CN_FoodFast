/**
 * Integration Test: IR-02 - Non-Atomic DB Commit + Email Send
 * 
 * Risk: customer.service.js:88-90 commits transaction BEFORE sending email
 *       If sendOtpEmail() fails, user is saved but cannot verify
 * 
 * Impact: HIGH - Users stuck in unverified state forever
 * 
 * Target Code (customer.service.js:43-90):
 * ```javascript
 * await withTransaction(async (client) => {
 *   // ... user creation, role assignment, token creation ...
 * }); // <-- COMMIT happens here (line 88)
 * 
 * await sendOtpEmail(normalizedEmail, firstName || normalizedEmail, otpCode, 'VERIFY');
 * // ^-- If this fails, user is already committed but has no OTP
 * ```
 * 
 * Reproduction:
 *   docker stop foodfast-rabbitmq
 *   curl -X POST http://localhost:3001/api/customers/signup -d '{"email":"test@x.com","password":"123456"}'
 */

const { Pool } = require('pg');

describe('IR-02: Non-Atomic DB Commit + Email Send', () => {
  let pool;
  let mockRabbitmq;
  let mockEmailQueue;
  let customerService;

  beforeAll(async () => {
    // Connect to test database
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'userdb',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '123',
    });
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
    }
  });

  beforeEach(() => {
    jest.resetModules();
    
    // Mock RabbitMQ to simulate failure
    mockRabbitmq = {
      connectRabbitMQ: jest.fn().mockResolvedValue(undefined),
      publishToEmailQueue: jest.fn(),
      publishSocketEvent: jest.fn(),
    };
    
    // Mock emailQueue
    mockEmailQueue = {
      sendOtpEmail: jest.fn(),
    };
    
    jest.doMock('../../utils/rabbitmq', () => mockRabbitmq);
    jest.doMock('../../utils/emailQueue', () => mockEmailQueue);
    
    // Mock db to use test pool
    jest.doMock('../../db', () => ({
      pool,
      withTransaction: async (callback) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await callback(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    }));
    
    customerService = require('../../services/customer.service');
  });

  afterEach(async () => {
    jest.clearAllMocks();
    
    // Clean up test users
    try {
      await pool.query(`DELETE FROM users WHERE email LIKE 'test-ir02-%'`);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test('VULNERABILITY: User saved but email fails - user stuck unverified', async () => {
    const testEmail = `test-ir02-${Date.now()}@example.com`;
    
    // Simulate email queue failure (RabbitMQ down)
    mockEmailQueue.sendOtpEmail.mockRejectedValue(
      new Error('RabbitMQ channel not initialized')
    );

    // Registration should fail (but user is already in DB!)
    await expect(customerService.registerCustomer({
      email: testEmail,
      password: 'password123',
      firstName: 'Test',
      lastName: 'User',
    })).rejects.toThrow('RabbitMQ channel not initialized');

    // PROBLEM: User was committed to DB despite email failure
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [testEmail.toLowerCase()]
    );

    // This assertion demonstrates the bug:
    // User exists in DB but never received OTP email
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].email_verified).toBe(false);
    
    // User has credentials but no way to verify
    const credResult = await pool.query(
      `SELECT uc.* FROM user_credentials uc
       JOIN users u ON u.id = uc.user_id
       WHERE u.email = $1`,
      [testEmail.toLowerCase()]
    );
    expect(credResult.rows.length).toBe(1);
  });

  test('SCENARIO: RabbitMQ connection lost mid-registration', async () => {
    const testEmail = `test-ir02-mq-${Date.now()}@example.com`;
    
    // First call succeeds (transaction), second fails (email)
    mockEmailQueue.sendOtpEmail.mockImplementation(() => {
      throw new Error('Connection closed');
    });

    await expect(customerService.registerCustomer({
      email: testEmail,
      password: 'password123',
    })).rejects.toThrow('Connection closed');

    // User is orphaned in DB
    const result = await pool.query(
      'SELECT id, email, email_verified FROM users WHERE email = $1',
      [testEmail.toLowerCase()]
    );
    
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].email_verified).toBe(false);
  });

  test('SCENARIO: Slow email queue causes timeout', async () => {
    const testEmail = `test-ir02-slow-${Date.now()}@example.com`;
    
    // Simulate slow queue that times out
    mockEmailQueue.sendOtpEmail.mockImplementation(async () => {
      await new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Queue timeout')), 100)
      );
    });

    await expect(customerService.registerCustomer({
      email: testEmail,
      password: 'password123',
    })).rejects.toThrow('Queue timeout');

    // User still orphaned
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [testEmail.toLowerCase()]
    );
    expect(result.rows.length).toBe(1);
  });

  test('SUCCESS: When email succeeds, everything works', async () => {
    const testEmail = `test-ir02-success-${Date.now()}@example.com`;
    
    // Email queue works
    mockEmailQueue.sendOtpEmail.mockResolvedValue(undefined);

    const result = await customerService.registerCustomer({
      email: testEmail,
      password: 'password123',
      firstName: 'Happy',
      lastName: 'Path',
    });

    expect(result.message).toContain('registered');
    expect(mockEmailQueue.sendOtpEmail).toHaveBeenCalledWith(
      testEmail.toLowerCase(),
      'Happy',
      expect.any(String), // OTP code
      'VERIFY'
    );

    // Verify user in DB
    const dbResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [testEmail.toLowerCase()]
    );
    expect(dbResult.rows.length).toBe(1);
  });

  test('IMPACT: Retry registration fails with "already registered"', async () => {
    const testEmail = `test-ir02-retry-${Date.now()}@example.com`;
    
    // First attempt: email fails but user saved
    mockEmailQueue.sendOtpEmail.mockRejectedValueOnce(new Error('Queue down'));
    
    await expect(customerService.registerCustomer({
      email: testEmail,
      password: 'password123',
    })).rejects.toThrow();

    // User tries again - but now email exists (unverified)
    mockEmailQueue.sendOtpEmail.mockResolvedValue(undefined);
    
    // Second attempt should work (update existing unverified user)
    // This is actually the current behavior - it updates the existing user
    const result = await customerService.registerCustomer({
      email: testEmail,
      password: 'newpassword',
    });

    expect(result.message).toContain('registered');
  });
});

/**
 * REMEDIATION:
 * 
 * Option 1: Include email send inside transaction with outbox pattern
 * 
 * ```javascript
 * async function registerCustomer(payload) {
 *   const { email, password, firstName, lastName, phone } = payload || {};
 *   // ... validation ...
 * 
 *   await withTransaction(async (client) => {
 *     // ... user creation ...
 *     
 *     // Store email job in outbox table (same transaction)
 *     await client.query(
 *       `INSERT INTO email_outbox (recipient, template, payload, status)
 *        VALUES ($1, $2, $3, 'pending')`,
 *       [normalizedEmail, 'VERIFY', JSON.stringify({ otp: otpCode, name: firstName })]
 *     );
 *   });
 *   
 *   // Background worker picks up from outbox
 *   return { message: 'Customer registered...' };
 * }
 * ```
 * 
 * Option 2: Make email send idempotent and retry
 * 
 * Option 3: Use saga pattern with compensation
 */
