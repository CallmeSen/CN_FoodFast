/**
 * Integration Test Setup for Payment Service
 * Provides mocks, utilities, and test infrastructure
 */

const express = require('express');
const jwt = require('jsonwebtoken');

// Test configuration
const TEST_CONFIG = {
  JWT_SECRET: 'test-secret-key-for-integration-tests',
  DB: {
    host: 'localhost',
    port: 5432,
    database: 'paymentdb_test',
    user: 'postgres',
    password: 'test123',
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  },
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  ORDER_EVENTS_QUEUE: 'order_events_test',
  PAYMENT_EVENTS_QUEUE: 'payment_events_test',
  STRIPE_SECRET_KEY: 'sk_test_mock_key',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_mock_key',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_mock',
  DEFAULT_CURRENCY: 'VND',
  PORT: 3099,
};

// Mock PostgreSQL Pool
class MockPool {
  constructor() {
    this.connected = true;
    this.clients = [];
    this.queryResults = [];
  }

  async connect() {
    if (!this.connected) {
      throw new Error('Connection refused');
    }
    const client = new MockClient(this.queryResults);
    this.clients.push(client);
    return client;
  }

  async query(sql, params) {
    if (!this.connected) {
      throw new Error('Connection refused');
    }
    const result = this.queryResults.shift();
    return result || { rows: [], rowCount: 0 };
  }

  setConnected(status) {
    this.connected = status;
  }

  setQueryResults(results) {
    this.queryResults = [...results];
  }
}

class MockClient {
  constructor(queryResults = []) {
    this.queryResults = queryResults;
    this.inTransaction = false;
    this.released = false;
  }

  async query(sql, params) {
    if (sql === 'BEGIN') {
      this.inTransaction = true;
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      this.inTransaction = false;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      this.inTransaction = false;
      return { rows: [] };
    }
    const result = this.queryResults.shift();
    return result || { rows: [], rowCount: 0 };
  }

  release() {
    this.released = true;
  }
}

// Mock RabbitMQ
class MockRabbitMQ {
  constructor() {
    this.connected = false;
    this.channels = [];
    this.queues = new Map();
    this.publishedMessages = [];
    this.consumers = new Map();
  }

  async connect() {
    if (!this.connected) {
      throw new Error('RabbitMQ connection failed');
    }
    return {
      createChannel: async () => this.createChannel(),
      on: jest.fn(),
      close: async () => { this.connected = false; },
    };
  }

  async createChannel() {
    const channel = {
      assertQueue: async (queue) => {
        this.queues.set(queue, []);
        return { queue };
      },
      sendToQueue: (queue, buffer, options) => {
        const messages = this.queues.get(queue) || [];
        messages.push({
          content: buffer,
          options,
          timestamp: Date.now(),
        });
        this.queues.set(queue, messages);
        this.publishedMessages.push({ queue, content: JSON.parse(buffer.toString()), options });
        return true;
      },
      consume: async (queue, handler, options) => {
        this.consumers.set(queue, handler);
        return { consumerTag: `consumer-${queue}` };
      },
      ack: jest.fn(),
      nack: jest.fn(),
      close: jest.fn(),
    };
    this.channels.push(channel);
    return channel;
  }

  setConnected(status) {
    this.connected = status;
  }

  getPublishedMessages() {
    return this.publishedMessages;
  }

  clearMessages() {
    this.publishedMessages = [];
    this.queues.clear();
  }

  async simulateMessage(queue, message) {
    const handler = this.consumers.get(queue);
    if (handler) {
      await handler({
        content: Buffer.from(JSON.stringify(message)),
      });
    }
  }
}

// Mock Stripe
class MockStripe {
  constructor() {
    this.configured = true;
    this.customers = new Map();
    this.paymentIntents = [];
    this.refunds = [];
    this.setupIntents = [];
    this.paymentMethods = new Map();
    this.shouldFail = false;
    this.failureReason = null;
  }

  setConfigured(status) {
    this.configured = status;
  }

  setShouldFail(shouldFail, reason = 'Stripe API error') {
    this.shouldFail = shouldFail;
    this.failureReason = reason;
  }

  async createCustomer(data) {
    if (!this.configured) throw new Error('Stripe not configured');
    if (this.shouldFail) throw new Error(this.failureReason);
    const customer = {
      id: `cus_${Date.now()}`,
      ...data,
    };
    this.customers.set(customer.id, customer);
    return customer;
  }

  async createPaymentIntent(data) {
    if (!this.configured) throw new Error('Stripe not configured');
    if (this.shouldFail) throw new Error(this.failureReason);
    const intent = {
      id: `pi_${Date.now()}`,
      status: 'succeeded',
      ...data,
    };
    this.paymentIntents.push(intent);
    return intent;
  }

  async createSetupIntent(data) {
    if (!this.configured) throw new Error('Stripe not configured');
    if (this.shouldFail) throw new Error(this.failureReason);
    const intent = {
      id: `seti_${Date.now()}`,
      client_secret: `seti_secret_${Date.now()}`,
      ...data,
    };
    this.setupIntents.push(intent);
    return intent;
  }

  async refund(data) {
    if (!this.configured) throw new Error('Stripe not configured');
    if (this.shouldFail) throw new Error(this.failureReason);
    const refund = {
      id: `re_${Date.now()}`,
      status: 'succeeded',
      ...data,
    };
    this.refunds.push(refund);
    return refund;
  }

  reset() {
    this.customers.clear();
    this.paymentIntents = [];
    this.refunds = [];
    this.setupIntents = [];
    this.paymentMethods.clear();
    this.shouldFail = false;
    this.failureReason = null;
  }
}

// Token utilities
function generateValidToken(payload, secret = TEST_CONFIG.JWT_SECRET) {
  return jwt.sign(
    {
      id: payload.id || 'test-user-id',
      userId: payload.userId || payload.id || 'test-user-id',
      role: payload.role || 'customer',
      roles: payload.roles || [payload.role || 'customer'],
      email: payload.email || 'test@example.com',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret
  );
}

function generateExpiredToken(payload, secret = TEST_CONFIG.JWT_SECRET) {
  return jwt.sign(
    {
      ...payload,
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    },
    secret
  );
}

function generateTokenWithWrongSecret(payload) {
  return jwt.sign(payload, 'wrong-secret-key');
}

// Test Express app factory
function createTestApp(config = {}) {
  const app = express();
  app.use(express.json());
  
  // Add test metadata endpoint
  app.get('/test/config', (req, res) => {
    res.json({
      jwt_secret: config.JWT_SECRET || TEST_CONFIG.JWT_SECRET,
      stripe_configured: !!config.STRIPE_SECRET_KEY,
    });
  });

  return app;
}

// Async utilities
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForCondition = async (condition, timeout = 5000, interval = 100) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return true;
    await wait(interval);
  }
  throw new Error('Condition not met within timeout');
};

module.exports = {
  TEST_CONFIG,
  MockPool,
  MockClient,
  MockRabbitMQ,
  MockStripe,
  generateValidToken,
  generateExpiredToken,
  generateTokenWithWrongSecret,
  createTestApp,
  wait,
  waitForCondition,
};
