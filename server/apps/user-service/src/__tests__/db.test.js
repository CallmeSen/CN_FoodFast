/**
 * Unit Tests for user-service - Database Utility Layer
 * Tests: withTransaction() - ROLLBACK on error scenarios
 */

const { Pool } = require('pg');

// Mock pg module before importing db
jest.mock('pg', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  const mockPool = {
    connect: jest.fn().mockResolvedValue(mockClient),
  };
  return { Pool: jest.fn(() => mockPool) };
});

// Mock config
jest.mock('../config', () => ({
  DB: {
    host: 'localhost',
    port: 5432,
    database: 'test_db',
    user: 'test_user',
    password: 'test_password',
  },
}));

// Import after mocking
const { pool, withTransaction } = require('../db');

describe('Database Utility - withTransaction()', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    // Get reference to the mock client
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(mockClient);
  });

  // =========================================================================
  // TEST #8: withTransaction() - ERROR CASES (ROLLBACK behavior)
  // =========================================================================
  describe('withTransaction() - Error Cases', () => {
    it('should execute ROLLBACK when callback throws an error', async () => {
      // GIVEN - A transaction callback that throws an error
      const testError = new Error('Database constraint violation');
      const failingCallback = jest.fn().mockRejectedValue(testError);

      mockClient.query.mockResolvedValue({ rows: [] });

      // WHEN - Transaction is executed with failing callback
      // THEN - Should throw the original error and execute ROLLBACK
      await expect(withTransaction(failingCallback)).rejects.toThrow('Database constraint violation');

      // Verify transaction lifecycle: BEGIN -> ROLLBACK (no COMMIT)
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.query).not.toHaveBeenCalledWith('COMMIT');

      // Verify client is always released
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should release client even when ROLLBACK fails', async () => {
      // GIVEN - Callback fails AND rollback also fails
      const callbackError = new Error('Insert failed');
      const rollbackError = new Error('ROLLBACK failed - connection lost');
      const failingCallback = jest.fn().mockRejectedValue(callbackError);

      mockClient.query
        .mockResolvedValueOnce({ rows: [] }) // BEGIN succeeds
        .mockRejectedValueOnce(rollbackError); // ROLLBACK fails

      // WHEN - Transaction fails and rollback also fails
      // THEN - Should throw the ROLLBACK error (it overwrites callback error)
      await expect(withTransaction(failingCallback)).rejects.toThrow('ROLLBACK failed - connection lost');

      // Verify client is STILL released (finally block)
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should propagate error with correct properties', async () => {
      // GIVEN - A custom error with status property
      const customError = new Error('Validation failed');
      customError.status = 400;
      customError.code = 'VALIDATION_ERROR';
      const failingCallback = jest.fn().mockRejectedValue(customError);

      mockClient.query.mockResolvedValue({ rows: [] });

      // WHEN - Transaction fails with custom error
      // THEN - Error properties should be preserved
      try {
        await withTransaction(failingCallback);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.message).toBe('Validation failed');
        expect(error.status).toBe(400);
        expect(error.code).toBe('VALIDATION_ERROR');
      }

      // Verify ROLLBACK was called
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    });

    it('should execute COMMIT when callback succeeds', async () => {
      // GIVEN - A successful transaction callback
      const successCallback = jest.fn().mockResolvedValue({ id: 'new-record-123' });

      mockClient.query.mockResolvedValue({ rows: [] });

      // WHEN - Transaction callback succeeds
      const result = await withTransaction(successCallback);

      // THEN - Should return callback result and execute COMMIT
      expect(result).toEqual({ id: 'new-record-123' });

      // Verify transaction lifecycle: BEGIN -> COMMIT (no ROLLBACK)
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.query).not.toHaveBeenCalledWith('ROLLBACK');

      // Verify client is released
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should pass client to callback for transactional queries', async () => {
      // GIVEN - A callback that uses the client
      const transactionCallback = jest.fn().mockImplementation(async (client) => {
        // Verify client is passed correctly
        expect(client).toBeDefined();
        expect(client.query).toBeDefined();
        return { inserted: true };
      });

      mockClient.query.mockResolvedValue({ rows: [] });

      // WHEN - Transaction is executed
      await withTransaction(transactionCallback);

      // THEN - Callback should have received the client
      expect(transactionCallback).toHaveBeenCalledWith(mockClient);
    });

    it('should handle synchronous errors in callback', async () => {
      // GIVEN - A callback that throws synchronously
      const syncErrorCallback = jest.fn().mockImplementation(() => {
        throw new Error('Sync error in transaction');
      });

      mockClient.query.mockResolvedValue({ rows: [] });

      // WHEN - Transaction callback throws synchronously
      // THEN - Should still trigger ROLLBACK
      await expect(withTransaction(syncErrorCallback)).rejects.toThrow('Sync error in transaction');

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('should handle null return from callback', async () => {
      // GIVEN - A callback that returns null
      const nullCallback = jest.fn().mockResolvedValue(null);

      mockClient.query.mockResolvedValue({ rows: [] });

      // WHEN - Transaction callback returns null
      const result = await withTransaction(nullCallback);

      // THEN - Should complete successfully with null result
      expect(result).toBeNull();
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('should handle undefined return from callback', async () => {
      // GIVEN - A callback that returns undefined (void)
      const voidCallback = jest.fn().mockResolvedValue(undefined);

      mockClient.query.mockResolvedValue({ rows: [] });

      // WHEN - Transaction callback returns undefined
      const result = await withTransaction(voidCallback);

      // THEN - Should complete successfully with undefined result
      expect(result).toBeUndefined();
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
    });

    it('should handle connection pool failure', async () => {
      // GIVEN - Pool.connect fails
      const connectionError = new Error('Connection pool exhausted');
      pool.connect.mockRejectedValue(connectionError);

      const callback = jest.fn();

      // WHEN - Transaction cannot acquire connection
      // THEN - Should throw connection error
      await expect(withTransaction(callback)).rejects.toThrow('Connection pool exhausted');

      // Callback should never be called
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
