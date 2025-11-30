/**
 * Jest Setup for Product Service Integration Tests
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
process.env.DB_PORT = process.env.DB_PORT || '5433';
process.env.DB_NAME = process.env.DB_NAME || 'productdb';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || '123';
process.env.RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
process.env.SOCKET_QUEUE = process.env.SOCKET_QUEUE || 'socket_events';
process.env.USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3001';
process.env.USER_SERVICE_TIMEOUT = process.env.USER_SERVICE_TIMEOUT || '5000';

// Clean up after all tests
afterAll(async () => {
  // Give time for connections to close
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
