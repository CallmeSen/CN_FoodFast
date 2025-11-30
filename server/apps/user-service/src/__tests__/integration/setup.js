/**
 * Jest Setup for User Service Integration Tests
 */

// Increase timeout for integration tests
jest.setTimeout(30000);

// Suppress console.log during tests unless DEBUG is set
if (!process.env.DEBUG) {
  global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    // Keep warn and error for visibility
    warn: console.warn,
    error: console.error,
  };
}

// Environment variables for tests
process.env.NODE_ENV = 'test';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_NAME = process.env.DB_NAME || 'userdb';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || '123';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
process.env.RABBITMQ_QUEUE = process.env.RABBITMQ_QUEUE || 'email_queue';

// Clean up after all tests
afterAll(async () => {
  // Give time for connections to close
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
