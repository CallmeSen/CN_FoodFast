/**
 * Integration Test: IR-04 - Non-Atomic Restaurant + Owner Account Creation
 * 
 * Risk: restaurant.service.js:107-118 commits transaction BEFORE calling user-service
 *       If createOwnerMainAccount() fails, restaurant exists but owner account doesn't
 * 
 * Impact: HIGH - Orphaned restaurants with no owner access
 * 
 * Target Code (restaurant.service.js:91-118):
 * ```javascript
 * const { restaurant, defaultTax } = await withTransaction(async (client) => {
 *   const restaurant = await restaurantRepository.createRestaurant({...}, client);
 *   const defaultTax = await ensureRestaurantDefaultTax(restaurant.id, client);
 *   return { restaurant, defaultTax };
 * }); // <-- COMMIT happens here (line 106)
 * 
 * // Now call external service AFTER commit
 * try {
 *   ownerAccountResponse = await createOwnerMainAccount({...});
 * } catch (error) {
 *   console.error('[product-service] Failed to create owner main account:', error.message);
 *   // Restaurant already committed! No rollback possible
 * }
 * ```
 * 
 * Reproduction:
 *   docker stop user-service
 *   curl -X POST http://localhost:3002/api/restaurants -d '{"name":"Test","ownerUserId":"123"}'
 */

const { Pool } = require('pg');

describe('IR-04: Non-Atomic Restaurant + Owner Account Creation', () => {
  let pool;
  let mockUserServiceClient;
  let mockRabbitmq;
  let restaurantService;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'productdb',
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

    // Mock RabbitMQ
    mockRabbitmq = {
      connectRabbitMQ: jest.fn().mockResolvedValue(undefined),
      publishSocketEvent: jest.fn(),
    };

    // Mock user service client
    mockUserServiceClient = {
      createOwnerMainAccount: jest.fn(),
      createRestaurantMember: jest.fn(),
    };

    jest.doMock('../../utils/rabbitmq', () => mockRabbitmq);
    jest.doMock('../../utils/userServiceClient', () => mockUserServiceClient);

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

    restaurantService = require('../../services/restaurant.service');
  });

  afterEach(async () => {
    jest.clearAllMocks();

    // Cleanup test restaurants
    try {
      await pool.query(`DELETE FROM restaurants WHERE name LIKE 'test-ir04-%'`);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test('VULNERABILITY: Restaurant saved but owner account fails - orphaned restaurant', async () => {
    const testName = `test-ir04-orphan-${Date.now()}`;

    // Simulate user-service failure
    mockUserServiceClient.createOwnerMainAccount.mockRejectedValue(
      new Error('Connection refused: user-service down')
    );

    // Create restaurant - should NOT throw because error is caught
    const result = await restaurantService.createRestaurant({
      ownerUserId: 'owner-123',
      name: testName,
      ownerMainAccount: { loginEmail: 'owner@test.com' },
    });

    // Restaurant was created
    expect(result.restaurant).toBeDefined();
    expect(result.restaurant.name).toBe(testName);

    // But owner account failed
    expect(mockUserServiceClient.createOwnerMainAccount).toHaveBeenCalled();

    // Verify restaurant exists in DB (orphaned)
    const dbResult = await pool.query(
      'SELECT * FROM restaurants WHERE name = $1',
      [testName]
    );
    expect(dbResult.rows.length).toBe(1);

    // Owner has no access to this restaurant now!
  });

  test('VULNERABILITY: User-service timeout causes orphaned restaurant', async () => {
    const testName = `test-ir04-timeout-${Date.now()}`;

    // Simulate timeout
    mockUserServiceClient.createOwnerMainAccount.mockImplementation(async () => {
      await new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), 100)
      );
    });

    const result = await restaurantService.createRestaurant({
      ownerUserId: 'owner-456',
      name: testName,
      ownerMainAccount: { loginEmail: 'timeout@test.com' },
    });

    // Restaurant created despite timeout
    expect(result.restaurant.name).toBe(testName);

    // Verify orphaned in DB
    const dbResult = await pool.query(
      'SELECT * FROM restaurants WHERE name = $1',
      [testName]
    );
    expect(dbResult.rows.length).toBe(1);
  });

  test('VULNERABILITY: User-service 500 error leaves orphaned restaurant', async () => {
    const testName = `test-ir04-500-${Date.now()}`;

    mockUserServiceClient.createOwnerMainAccount.mockRejectedValue(
      new Error('Internal Server Error')
    );

    const result = await restaurantService.createRestaurant({
      ownerUserId: 'owner-789',
      name: testName,
      ownerMainAccount: { loginEmail: 'error@test.com' },
    });

    expect(result.restaurant).toBeDefined();

    // Restaurant orphaned
    const dbResult = await pool.query(
      'SELECT * FROM restaurants WHERE name = $1',
      [testName]
    );
    expect(dbResult.rows.length).toBe(1);
  });

  test('SUCCESS: When user-service works, both restaurant and account created', async () => {
    const testName = `test-ir04-success-${Date.now()}`;

    mockUserServiceClient.createOwnerMainAccount.mockResolvedValue({
      account: { id: 'acc-123', loginEmail: 'success@test.com' },
      membership: { role: 'owner_main' },
    });

    const result = await restaurantService.createRestaurant({
      ownerUserId: 'owner-ok',
      name: testName,
      ownerMainAccount: { loginEmail: 'success@test.com' },
    });

    expect(result.restaurant).toBeDefined();
    expect(result.ownerMainAccount).toBeDefined();
    expect(mockUserServiceClient.createOwnerMainAccount).toHaveBeenCalled();
  });

  test('IMPACT: Socket event still published despite owner account failure', async () => {
    const testName = `test-ir04-socket-${Date.now()}`;

    mockUserServiceClient.createOwnerMainAccount.mockRejectedValue(
      new Error('User service unavailable')
    );

    await restaurantService.createRestaurant({
      ownerUserId: 'owner-socket',
      name: testName,
      ownerMainAccount: { loginEmail: 'socket@test.com' },
    });

    // Socket event was still published (restaurant.created)
    expect(mockRabbitmq.publishSocketEvent).toHaveBeenCalledWith(
      'restaurant.created',
      expect.objectContaining({
        restaurant: expect.objectContaining({ name: testName }),
      }),
      expect.any(Array)
    );

    // This means clients may think restaurant is fully created when it's not
  });

  test('SCENARIO: Multiple concurrent creates with user-service flaky', async () => {
    let callCount = 0;

    // Simulate flaky user-service (fails every other call)
    mockUserServiceClient.createOwnerMainAccount.mockImplementation(async () => {
      callCount++;
      if (callCount % 2 === 0) {
        throw new Error('Flaky service failure');
      }
      return { account: { id: `acc-${callCount}` } };
    });

    const results = await Promise.all([
      restaurantService.createRestaurant({
        ownerUserId: 'owner-1',
        name: `test-ir04-flaky-1-${Date.now()}`,
        ownerMainAccount: { loginEmail: 'f1@test.com' },
      }),
      restaurantService.createRestaurant({
        ownerUserId: 'owner-2',
        name: `test-ir04-flaky-2-${Date.now()}`,
        ownerMainAccount: { loginEmail: 'f2@test.com' },
      }),
      restaurantService.createRestaurant({
        ownerUserId: 'owner-3',
        name: `test-ir04-flaky-3-${Date.now()}`,
        ownerMainAccount: { loginEmail: 'f3@test.com' },
      }),
    ]);

    // All restaurants created
    expect(results.every((r) => r.restaurant)).toBe(true);

    // But some have owner accounts, some don't (orphaned)
    const withAccounts = results.filter((r) => r.ownerMainAccount?.account);
    const orphaned = results.filter((r) => !r.ownerMainAccount?.account);

    expect(orphaned.length).toBeGreaterThan(0);
  });
});

/**
 * REMEDIATION:
 * 
 * Option 1: Saga pattern with compensation
 * 
 * ```javascript
 * async function createRestaurant(payload = {}) {
 *   let restaurant = null;
 *   
 *   try {
 *     // Step 1: Create restaurant
 *     const { restaurant: created, defaultTax } = await withTransaction(async (client) => {
 *       const restaurant = await restaurantRepository.createRestaurant({...}, client);
 *       const defaultTax = await ensureRestaurantDefaultTax(restaurant.id, client);
 *       return { restaurant, defaultTax };
 *     });
 *     restaurant = created;
 * 
 *     // Step 2: Create owner account (external call)
 *     const ownerAccountResponse = await createOwnerMainAccount({...});
 * 
 *     return { restaurant, ownerMainAccount: ownerAccountResponse };
 * 
 *   } catch (error) {
 *     // Compensation: Delete orphaned restaurant
 *     if (restaurant) {
 *       try {
 *         await restaurantRepository.deleteRestaurant(restaurant.id);
 *         console.log('[compensation] Deleted orphaned restaurant:', restaurant.id);
 *       } catch (deleteError) {
 *         console.error('[compensation] Failed to delete restaurant:', deleteError.message);
 *       }
 *     }
 *     throw error;
 *   }
 * }
 * ```
 * 
 * Option 2: Use outbox pattern - store pending account creation in DB
 * 
 * Option 3: Make owner account creation mandatory (throw on failure)
 */
