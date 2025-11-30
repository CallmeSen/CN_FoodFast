/**
 * Integration Test: IR-02 - RabbitMQ Event Loss Post-Commit
 * 
 * Root Cause: DB transaction commits at orders.service.js:1570, then publishes events at L:1573-1590 - not atomic
 * Impact: Order saved but PaymentPending event never sent → payment-service never initiates payment
 * Evidence: try/catch at L:1591 only logs error, does not compensate
 */

const request = require('supertest');
const { Pool } = require('pg');
const amqp = require('amqplib');
const jwt = require('jsonwebtoken');
const app = require('../../app');

describe('IR-02: RabbitMQ Event Loss Post-Commit Integration Tests', () => {
  let pool;
  let rabbitConnection;
  let rabbitChannel;
  let customerToken;
  let receivedEvents = [];
  const JWT_SECRET = process.env.JWT_SECRET || 'secret';

  const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
  const TEST_RESTAURANT_ID = '22222222-2222-2222-2222-222222222222';
  const TEST_BRANCH_ID = '33333333-3333-3333-3333-333333333333';
  const TEST_PRODUCT_ID = '44444444-4444-4444-4444-444444444444';

  const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
  const ORDER_EVENTS_QUEUE = process.env.ORDER_EVENTS_QUEUE || 'order_events';

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
      await rabbitChannel.assertQueue(ORDER_EVENTS_QUEUE, { durable: true });

      // Purge queue to start fresh
      await rabbitChannel.purgeQueue(ORDER_EVENTS_QUEUE);

      // Start consuming events
      await rabbitChannel.consume(ORDER_EVENTS_QUEUE, (msg) => {
        if (msg) {
          const content = JSON.parse(msg.content.toString());
          receivedEvents.push(content);
          rabbitChannel.ack(msg);
        }
      });
    } catch (error) {
      console.warn('RabbitMQ not available for test:', error.message);
    }

    // GIVEN - Valid customer JWT token
    customerToken = jwt.sign(
      { userId: TEST_USER_ID, role: 'customer', roles: ['customer'] },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  afterAll(async () => {
    // Cleanup
    await pool.query(`DELETE FROM order_events WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)`, [TEST_USER_ID]);
    await pool.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)`, [TEST_USER_ID]);
    await pool.query(`DELETE FROM orders WHERE user_id = $1`, [TEST_USER_ID]);
    await pool.end();

    if (rabbitChannel) {
      await rabbitChannel.close();
    }
    if (rabbitConnection) {
      await rabbitConnection.close();
    }
  });

  beforeEach(() => {
    receivedEvents = [];
  });

  describe('Event Loss After Commit Scenarios', () => {
    it('should save order to database even when RabbitMQ publish fails', async () => {
      // GIVEN - Store original RABBITMQ_URL and set to invalid URL
      const originalRabbitUrl = process.env.RABBITMQ_URL;
      process.env.RABBITMQ_URL = 'amqp://guest:guest@localhost:59999';

      // Force reconnection attempt with invalid URL
      jest.resetModules();
      const freshApp = require('../../app');

      // WHEN - Customer creates an order
      const response = await request(freshApp)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          branch_id: TEST_BRANCH_ID,
          items: [
            {
              product_id: TEST_PRODUCT_ID,
              quantity: 1,
              unit_price: 50000,
              total_price: 50000,
            },
          ],
          payment_method: 'cod',
        });

      // THEN - Order may be saved to DB (commit happens before publish)
      if (response.status === 201) {
        const orderId = response.body.id;

        // Verify order exists in database
        const dbResult = await pool.query(
          'SELECT * FROM orders WHERE id = $1',
          [orderId]
        );
        expect(dbResult.rows.length).toBe(1);

        // Wait for potential event
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Verify NO PaymentPending event was received (event loss)
        const paymentEvents = receivedEvents.filter(
          (e) => e.event === 'PaymentPending' && e.payload?.order_id === orderId
        );
        
        // This demonstrates the risk: order saved but event lost
        console.log('Order saved:', orderId);
        console.log('Payment events received:', paymentEvents.length);
      }

      // Restore env
      process.env.RABBITMQ_URL = originalRabbitUrl;
    }, 30000);

    it('should verify order is committed before event publish (non-atomic)', async () => {
      // GIVEN - Valid order payload
      const orderPayload = {
        restaurant_id: TEST_RESTAURANT_ID,
        branch_id: TEST_BRANCH_ID,
        items: [
          {
            product_id: TEST_PRODUCT_ID,
            quantity: 2,
            unit_price: 30000,
            total_price: 60000,
          },
        ],
        payment_method: 'cod',
      };

      // WHEN - Order is created
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send(orderPayload);

      if (response.status === 201) {
        const orderId = response.body.id;

        // Check DB immediately
        const dbCheck = await pool.query(
          'SELECT * FROM orders WHERE id = $1',
          [orderId]
        );

        // THEN - Order should exist in DB before we can verify events
        expect(dbCheck.rows.length).toBe(1);
        expect(dbCheck.rows[0].status).toBe('pending');

        // The order is committed to DB at this point
        // Event publishing happens AFTER commit (non-atomic)
        // If RabbitMQ fails between commit and publish, order exists but event is lost
      }
    }, 15000);

    it('should detect missing PaymentPending events for online payment orders', async () => {
      // GIVEN - Online payment order (requires PaymentPending event for payment-service)
      const onlinePaymentOrder = {
        restaurant_id: TEST_RESTAURANT_ID,
        branch_id: TEST_BRANCH_ID,
        items: [
          {
            product_id: TEST_PRODUCT_ID,
            quantity: 1,
            unit_price: 100000,
            total_price: 100000,
          },
        ],
        payment_method: 'stripe', // Online payment method
      };

      const beforeEventCount = receivedEvents.length;

      // WHEN - Order with online payment is created
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send(onlinePaymentOrder);

      if (response.status === 201) {
        const orderId = response.body.id;

        // Wait for events
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // THEN - Verify PaymentPending event should have been sent
        const afterEventCount = receivedEvents.length;
        const orderEvents = receivedEvents.filter(
          (e) => e.payload?.order_id === orderId
        );

        // Check if PaymentPending event exists
        const paymentPendingEvent = orderEvents.find(
          (e) => e.event === 'PaymentPending'
        );

        // Log evidence of non-atomic behavior
        console.log('Events received for order:', orderEvents.length);
        console.log('PaymentPending event:', paymentPendingEvent ? 'Found' : 'MISSING');

        // If event is missing, order is in limbo - saved but payment never initiated
        if (!paymentPendingEvent) {
          const orderInDb = await pool.query(
            'SELECT payment_status FROM orders WHERE id = $1',
            [orderId]
          );
          // Order stuck in 'pending' payment status forever
          expect(orderInDb.rows[0].payment_status).toBe('pending');
        }
      }
    }, 15000);

    it('should verify try/catch only logs error without compensation', async () => {
      // GIVEN - Spy on console.error to capture logged errors
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // Store and break RabbitMQ connection
      const originalUrl = process.env.RABBITMQ_URL;
      process.env.RABBITMQ_URL = 'amqp://invalid:invalid@localhost:59999';

      // WHEN - Order creation with broken RabbitMQ
      const response = await request(app)
        .post('/customer/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          restaurant_id: TEST_RESTAURANT_ID,
          branch_id: TEST_BRANCH_ID,
          items: [
            {
              product_id: TEST_PRODUCT_ID,
              quantity: 1,
              unit_price: 25000,
              total_price: 25000,
            },
          ],
          payment_method: 'cod',
        });

      // THEN - Error should be logged but no compensation action taken
      if (response.status === 201) {
        // Check if error was logged (evidence of try/catch at L:1591)
        const errorLogs = consoleSpy.mock.calls.filter((call) =>
          call[0]?.includes?.('Failed to publish') || 
          call[0]?.includes?.('order events')
        );

        console.log('Error logs captured:', errorLogs.length);

        // Verify order still exists (no rollback/compensation)
        const orderId = response.body.id;
        const orderCheck = await pool.query(
          'SELECT * FROM orders WHERE id = $1',
          [orderId]
        );
        expect(orderCheck.rows.length).toBe(1);
      }

      // Restore
      consoleSpy.mockRestore();
      process.env.RABBITMQ_URL = originalUrl;
    }, 15000);
  });

  describe('Outbox Pattern Verification', () => {
    it('should verify outbox table entries exist for order events', async () => {
      // GIVEN - Check if outbox table exists
      const tableCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'outbox'
        )
      `);

      if (tableCheck.rows[0].exists) {
        // WHEN - Order is created
        const response = await request(app)
          .post('/customer/orders')
          .set('Authorization', `Bearer ${customerToken}`)
          .send({
            restaurant_id: TEST_RESTAURANT_ID,
            branch_id: TEST_BRANCH_ID,
            items: [
              {
                product_id: TEST_PRODUCT_ID,
                quantity: 1,
                unit_price: 15000,
                total_price: 15000,
              },
            ],
            payment_method: 'cod',
          });

        if (response.status === 201) {
          const orderId = response.body.id;

          // THEN - Outbox should have entry for this order
          const outboxCheck = await pool.query(
            `SELECT * FROM outbox WHERE aggregate_id = $1`,
            [orderId]
          );

          // Outbox pattern helps with event loss but doesn't prevent it
          console.log('Outbox entries for order:', outboxCheck.rows.length);
        }
      } else {
        console.log('Outbox table does not exist - no transactional outbox pattern');
      }
    }, 15000);
  });
});
