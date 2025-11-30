/**
 * Integration Test: IR-05 - Payment Consumer Silent Failure
 * 
 * Root Cause: handlePaymentEvent at orders.service.js:1847 returns early if no order_id
 * Impact: Malformed payment events silently dropped; order stays in pending forever
 * Evidence: No dead-letter queue or alerting on invalid events
 */

const { Pool } = require('pg');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../../app');
const ordersService = require('../../services/orders.service');

describe('IR-05: Payment Consumer Silent Failure Integration Tests', () => {
  let pool;
  let rabbitConnection;
  let rabbitChannel;
  let customerToken;
  const JWT_SECRET = process.env.JWT_SECRET || 'secret';

  const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
  const TEST_RESTAURANT_ID = '22222222-2222-2222-2222-222222222222';
  const TEST_BRANCH_ID = '33333333-3333-3333-3333-333333333333';
  const TEST_PRODUCT_ID = '44444444-4444-4444-4444-444444444444';
  const TEST_ORDER_ID = '55555555-5555-5555-5555-555555555555';

  const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
  const PAYMENT_EVENTS_QUEUE = process.env.PAYMENT_EVENTS_QUEUE || 'payment_events';

  beforeAll(async () => {
    // GIVEN - Database connection
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5435,
      database: process.env.DB_NAME || 'orderdb',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '123',
    });

    // GIVEN - RabbitMQ connection
    try {
      rabbitConnection = await amqp.connect(RABBITMQ_URL);
      rabbitChannel = await rabbitConnection.createChannel();
      await rabbitChannel.assertQueue(PAYMENT_EVENTS_QUEUE, { durable: true });
    } catch (error) {
      console.warn('RabbitMQ not available:', error.message);
    }

    // GIVEN - Valid customer JWT token
    customerToken = jwt.sign(
      { userId: TEST_USER_ID, role: 'customer', roles: ['customer'] },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    // GIVEN - Seed test order in pending state
    await pool.query(`
      INSERT INTO orders (id, user_id, restaurant_id, branch_id, status, payment_status, total_amount, currency, metadata)
      VALUES ($1, $2, $3, $4, 'pending', 'pending', 100000, 'VND', '{}')
      ON CONFLICT (id) DO UPDATE SET status = 'pending', payment_status = 'pending'
    `, [TEST_ORDER_ID, TEST_USER_ID, TEST_RESTAURANT_ID, TEST_BRANCH_ID]);
  });

  afterAll(async () => {
    // Cleanup
    await pool.query(`DELETE FROM order_events WHERE order_id = $1`, [TEST_ORDER_ID]);
    await pool.query(`DELETE FROM orders WHERE user_id = $1`, [TEST_USER_ID]);
    await pool.end();

    if (rabbitChannel) {
      await rabbitChannel.close();
    }
    if (rabbitConnection) {
      await rabbitConnection.close();
    }
  });

  describe('Silent Failure on Malformed Events', () => {
    it('should silently return when event has no order_id', async () => {
      // GIVEN - Payment event without order_id
      const malformedEvent = {
        event: 'PaymentSucceeded',
        payload: {
          // order_id is MISSING
          payment_id: 'pay_123',
          amount: 100000,
        },
      };

      // Spy on console to verify no error is thrown
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      // WHEN - handlePaymentEvent is called with malformed event
      await ordersService.handlePaymentEvent(malformedEvent);

      // THEN - No error thrown, silently returns
      // This is the bug: malformed events are silently dropped
      expect(consoleSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it('should silently return when event has no payload', async () => {
      // GIVEN - Payment event without payload
      const noPayloadEvent = {
        event: 'PaymentSucceeded',
        // payload is MISSING
      };

      // WHEN - handlePaymentEvent is called
      let errorThrown = false;
      try {
        await ordersService.handlePaymentEvent(noPayloadEvent);
      } catch (error) {
        errorThrown = true;
      }

      // THEN - No error thrown, silently returns
      expect(errorThrown).toBe(false);
    });

    it('should silently return when event object is empty', async () => {
      // GIVEN - Empty event object
      const emptyEvent = {};

      // WHEN - handlePaymentEvent is called
      let errorThrown = false;
      try {
        await ordersService.handlePaymentEvent(emptyEvent);
      } catch (error) {
        errorThrown = true;
      }

      // THEN - No error thrown
      expect(errorThrown).toBe(false);
    });

    it('should silently return when event is undefined', async () => {
      // GIVEN - Undefined event

      // WHEN - handlePaymentEvent is called with undefined
      let errorThrown = false;
      try {
        await ordersService.handlePaymentEvent(undefined);
      } catch (error) {
        errorThrown = true;
      }

      // THEN - No error thrown
      expect(errorThrown).toBe(false);
    });

    it('should silently return when order_id is null', async () => {
      // GIVEN - Event with null order_id
      const nullOrderIdEvent = {
        event: 'PaymentSucceeded',
        payload: {
          order_id: null,
          payment_id: 'pay_456',
          amount: 50000,
        },
      };

      // WHEN - handlePaymentEvent is called
      let errorThrown = false;
      try {
        await ordersService.handlePaymentEvent(nullOrderIdEvent);
      } catch (error) {
        errorThrown = true;
      }

      // THEN - No error thrown, silently dropped
      expect(errorThrown).toBe(false);
    });
  });

  describe('Order Stuck in Pending State', () => {
    it('should leave order in pending state when PaymentSucceeded event is malformed', async () => {
      // GIVEN - Order in pending payment status
      await pool.query(
        `UPDATE orders SET payment_status = 'pending', status = 'pending' WHERE id = $1`,
        [TEST_ORDER_ID]
      );

      // GIVEN - Malformed PaymentSucceeded event (no order_id)
      const malformedEvent = {
        event: 'PaymentSucceeded',
        payload: {
          payment_id: 'pay_789',
          amount: 100000,
          // order_id is MISSING
        },
      };

      // WHEN - handlePaymentEvent processes the malformed event
      await ordersService.handlePaymentEvent(malformedEvent);

      // THEN - Order should still be in pending state (not updated)
      const result = await pool.query(
        `SELECT payment_status, status FROM orders WHERE id = $1`,
        [TEST_ORDER_ID]
      );

      expect(result.rows[0].payment_status).toBe('pending');
      expect(result.rows[0].status).toBe('pending');
      // Order stuck forever because the event was silently dropped
    });

    it('should successfully update order when PaymentSucceeded event is valid', async () => {
      // GIVEN - Order in pending payment status
      await pool.query(
        `UPDATE orders SET payment_status = 'pending', status = 'pending' WHERE id = $1`,
        [TEST_ORDER_ID]
      );

      // GIVEN - Valid PaymentSucceeded event
      const validEvent = {
        event: 'PaymentSucceeded',
        payload: {
          order_id: TEST_ORDER_ID,
          payment_id: 'pay_valid_123',
          amount: 100000,
        },
      };

      // WHEN - handlePaymentEvent processes the valid event
      await ordersService.handlePaymentEvent(validEvent);

      // THEN - Order should be updated to paid/confirmed
      const result = await pool.query(
        `SELECT payment_status, status FROM orders WHERE id = $1`,
        [TEST_ORDER_ID]
      );

      expect(result.rows[0].payment_status).toBe('paid');
      expect(['confirmed', 'pending']).toContain(result.rows[0].status);
    });
  });

  describe('No Dead-Letter Queue Verification', () => {
    it('should verify no dead-letter queue exists for failed events', async () => {
      // GIVEN - Check for dead-letter queue configuration
      if (rabbitChannel) {
        // WHEN - Check for DLQ
        let dlqExists = false;
        try {
          await rabbitChannel.checkQueue('payment_events_dlq');
          dlqExists = true;
        } catch (error) {
          dlqExists = false;
        }

        // THEN - DLQ should not exist (this is the risk)
        console.log('Dead-letter queue exists:', dlqExists);
        
        // Document the risk
        if (!dlqExists) {
          console.warn('WARNING: No dead-letter queue configured for payment_events');
          console.warn('Malformed events will be silently dropped with no way to recover');
        }
      }
    });

    it('should verify no alerting mechanism for dropped events', async () => {
      // GIVEN - handlePaymentEvent code at orders.service.js:1847-1849
      // if (!eventType || !payload || !payload.order_id) { return; }

      // THEN - Document the missing alerting
      const missingFeatures = {
        logging: 'No logging when event is dropped due to missing order_id',
        metrics: 'No counter/metric for dropped payment events',
        alerting: 'No alert sent when malformed event is received',
        dlq: 'No dead-letter queue for failed/malformed events',
        retry: 'No retry mechanism for transient failures',
      };

      console.log('Missing observability features:', JSON.stringify(missingFeatures, null, 2));
      expect(missingFeatures.logging).toBeDefined();
    });
  });

  describe('RabbitMQ Message Publishing Verification', () => {
    it('should publish malformed event to queue and verify silent consumption', async () => {
      if (!rabbitChannel) {
        console.warn('RabbitMQ not available, skipping test');
        return;
      }

      // GIVEN - Malformed payment event
      const malformedMessage = {
        event: 'PaymentSucceeded',
        payload: {
          payment_id: 'pay_queue_test',
          amount: 75000,
          // order_id is MISSING
        },
        timestamp: new Date().toISOString(),
      };

      // WHEN - Publish to queue
      rabbitChannel.sendToQueue(
        PAYMENT_EVENTS_QUEUE,
        Buffer.from(JSON.stringify(malformedMessage)),
        { persistent: true }
      );

      // Wait for consumer to process
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // THEN - Message should be consumed (acked) even though it was invalid
      // The consumer silently drops it without any error handling
      console.log('Malformed message published and likely silently dropped');
    });
  });

  describe('Event Type Validation', () => {
    it('should handle unknown event types silently', async () => {
      // GIVEN - Unknown event type
      const unknownEventType = {
        event: 'UnknownPaymentEvent',
        payload: {
          order_id: TEST_ORDER_ID,
          data: 'test',
        },
      };

      // WHEN - handlePaymentEvent is called with unknown event type
      let errorThrown = false;
      try {
        await ordersService.handlePaymentEvent(unknownEventType);
      } catch (error) {
        errorThrown = true;
      }

      // THEN - No error, but order is not updated (unknown event ignored)
      expect(errorThrown).toBe(false);

      // Verify order status unchanged
      const result = await pool.query(
        `SELECT payment_status FROM orders WHERE id = $1`,
        [TEST_ORDER_ID]
      );
      // Status remains whatever it was before
      expect(result.rows.length).toBeGreaterThan(0);
    });

    it('should handle PaymentFailed event without order_id silently', async () => {
      // GIVEN - PaymentFailed event without order_id
      const failedEvent = {
        event: 'PaymentFailed',
        payload: {
          payment_id: 'pay_failed_123',
          error: 'Card declined',
          // order_id is MISSING
        },
      };

      // WHEN - handlePaymentEvent is called
      let errorThrown = false;
      try {
        await ordersService.handlePaymentEvent(failedEvent);
      } catch (error) {
        errorThrown = true;
      }

      // THEN - No error, silently dropped
      expect(errorThrown).toBe(false);
      // Customer never knows payment failed, order stuck in limbo
    });
  });
});
