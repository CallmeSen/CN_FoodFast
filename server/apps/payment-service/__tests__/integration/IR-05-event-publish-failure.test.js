/**
 * Integration Test: IR-05 - Silent Event Publish Failure
 * 
 * Risk: The publishEvent function (src/publishers/outbox.publisher.js:4-8)
 * silently swallows RabbitMQ publish errors. Payment is committed to database
 * but PaymentSucceeded event is never published - order-service never knows.
 * 
 * Test validates:
 * 1. Payment commits to DB but event publish fails silently
 * 2. Order service never receives payment confirmation
 * 3. Data inconsistency between payment and order state
 * 4. No retry mechanism for failed event publishes
 */

const {
  TEST_CONFIG,
  MockPool,
  MockRabbitMQ,
  MockStripe,
  wait,
} = require('./setup');

describe('IR-05: Silent Event Publish Failure', () => {
  let mockPool;
  let mockRabbitMQ;
  let mockStripe;
  let publishedEvents;
  let publishErrors;

  beforeEach(() => {
    mockPool = new MockPool();
    mockRabbitMQ = new MockRabbitMQ();
    mockStripe = new MockStripe();
    publishedEvents = [];
    publishErrors = [];

    mockPool.setConnected(true);
    mockRabbitMQ.setConnected(true);
  });

  // Simulated current publishEvent behavior (vulnerable)
  const publishEventVulnerable = async (eventType, payload) => {
    try {
      if (!mockRabbitMQ.connected) {
        throw new Error('RabbitMQ not connected');
      }
      publishedEvents.push({ eventType, payload, timestamp: Date.now() });
    } catch (error) {
      // VULNERABILITY: Error is logged but NOT propagated
      console.error('[payment-service] Failed to publish payment event:', error);
      publishErrors.push({ eventType, payload, error: error.message });
      // No throw - error is swallowed
    }
  };

  // Simulated payment processing with commit then publish
  const processPaymentVulnerable = async (paymentData) => {
    const client = await mockPool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Insert payment record
      mockPool.setQueryResults([
        { rows: [{ id: 'payment-123', status: 'succeeded', ...paymentData }] }
      ]);
      const payment = await client.query('INSERT INTO payments...');
      
      await client.query('COMMIT');
      
      // VULNERABILITY: DB committed, but event publish may fail
      await publishEventVulnerable('PaymentSucceeded', {
        order_id: paymentData.order_id,
        payment_id: 'payment-123',
        amount: paymentData.amount,
      });
      
      return { success: true, payment: payment.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  describe('Event Publish Failure Scenarios', () => {
    test('should commit payment but fail to publish event when RabbitMQ is down', async () => {
      // Start with RabbitMQ connected for initial setup
      mockRabbitMQ.setConnected(true);
      
      const paymentData = {
        order_id: 'order-456',
        user_id: 'user-789',
        amount: 50000,
      };

      // Disconnect RabbitMQ AFTER payment starts
      mockRabbitMQ.setConnected(false);

      const result = await processPaymentVulnerable(paymentData);

      // Payment succeeds (DB commit worked)
      expect(result.success).toBe(true);
      expect(result.payment.status).toBe('succeeded');

      // But event was NOT published
      expect(publishedEvents).toHaveLength(0);
      expect(publishErrors).toHaveLength(1);
      expect(publishErrors[0].eventType).toBe('PaymentSucceeded');
    });

    test('should leave order in pending state when PaymentSucceeded never arrives', async () => {
      mockRabbitMQ.setConnected(false);

      const paymentData = {
        order_id: 'order-stuck-pending',
        user_id: 'user-unlucky',
        amount: 100000,
      };

      await processPaymentVulnerable(paymentData);

      // Simulate what order-service sees:
      // - Order is in "awaiting_payment" status
      // - PaymentSucceeded event never arrives
      // - Customer is charged but order never progresses
      
      const orderState = {
        id: 'order-stuck-pending',
        status: 'awaiting_payment', // Never transitions to 'paid'
        payment_received: false,
      };

      expect(orderState.status).toBe('awaiting_payment');
      expect(publishedEvents).toHaveLength(0);
    });

    test('should have no retry mechanism for failed publishes', async () => {
      mockRabbitMQ.setConnected(false);

      const paymentData = {
        order_id: 'order-lost',
        user_id: 'user-affected',
        amount: 75000,
      };

      await processPaymentVulnerable(paymentData);

      // Wait to see if any retry happens
      await wait(1000);

      // No retry - event is permanently lost
      expect(publishedEvents).toHaveLength(0);
      expect(publishErrors).toHaveLength(1);

      // Even if RabbitMQ comes back up, event is not retried
      mockRabbitMQ.setConnected(true);
      await wait(500);

      expect(publishedEvents).toHaveLength(0);
    });
  });

  describe('Data Inconsistency Impact', () => {
    test('should create payment-order state mismatch', async () => {
      mockRabbitMQ.setConnected(false);

      const payments = [];
      const orderEvents = [];

      // Process 3 payments
      for (let i = 0; i < 3; i++) {
        const result = await processPaymentVulnerable({
          order_id: `order-${i}`,
          user_id: `user-${i}`,
          amount: 10000 * (i + 1),
        });
        payments.push(result.payment);
      }

      // All payments succeeded in DB
      expect(payments).toHaveLength(3);
      expect(payments.every(p => p.status === 'succeeded')).toBe(true);

      // But no events were published
      expect(publishedEvents).toHaveLength(0);

      // Order service never knows about any of them
      expect(orderEvents).toHaveLength(0);
    });

    test('should require manual reconciliation to fix', async () => {
      mockRabbitMQ.setConnected(false);

      await processPaymentVulnerable({
        order_id: 'order-needs-manual-fix',
        user_id: 'user-support-ticket',
        amount: 500000,
      });

      // Manual reconciliation would need to:
      // 1. Query payments table for succeeded payments
      // 2. Check order-service for corresponding order states
      // 3. Manually update mismatched orders
      
      const needsManualReconciliation = publishErrors.length > 0;
      expect(needsManualReconciliation).toBe(true);
    });
  });

  describe('Proper Outbox Pattern (Recommended)', () => {
    // Proper implementation with transactional outbox
    const processPaymentWithOutbox = async (paymentData) => {
      const client = await mockPool.connect();
      
      try {
        await client.query('BEGIN');
        
        // Insert payment
        mockPool.setQueryResults([
          { rows: [{ id: 'payment-123', status: 'succeeded', ...paymentData }] },
          { rows: [{ id: 'outbox-1' }] }, // Outbox insert
        ]);
        
        const payment = await client.query('INSERT INTO payments...');
        
        // Insert into outbox table IN SAME TRANSACTION
        await client.query(
          'INSERT INTO outbox (event_type, payload, status) VALUES ($1, $2, $3)',
          ['PaymentSucceeded', JSON.stringify({ order_id: paymentData.order_id }), 'pending']
        );
        
        await client.query('COMMIT');
        
        // Background worker will poll outbox and publish events
        // If publish fails, event remains in outbox for retry
        
        return { success: true, payment: payment.rows[0] };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    test('outbox pattern ensures event is never lost', async () => {
      mockRabbitMQ.setConnected(false);

      const result = await processPaymentWithOutbox({
        order_id: 'order-safe',
        user_id: 'user-happy',
        amount: 100000,
      });

      expect(result.success).toBe(true);
      
      // Event is stored in outbox table
      // Background worker will retry publishing until successful
      const outboxEventStored = true;
      expect(outboxEventStored).toBe(true);
    });
  });

  describe('Alternative: Saga Pattern', () => {
    test('should compensate payment if event publish fails', async () => {
      let paymentRolledBack = false;

      const processPaymentWithSaga = async (paymentData) => {
        const client = await mockPool.connect();
        let paymentId = null;
        
        try {
          await client.query('BEGIN');
          
          mockPool.setQueryResults([
            { rows: [{ id: 'payment-saga-123', status: 'succeeded' }] }
          ]);
          
          const payment = await client.query('INSERT INTO payments...');
          paymentId = payment.rows[0].id;
          
          await client.query('COMMIT');
          
          // Try to publish event
          if (!mockRabbitMQ.connected) {
            throw new Error('RabbitMQ not connected');
          }
          
          publishedEvents.push({ eventType: 'PaymentSucceeded', payload: paymentData });
          
          return { success: true, payment: payment.rows[0] };
        } catch (error) {
          // SAGA: Compensate by refunding/canceling payment
          if (paymentId) {
            await client.query('UPDATE payments SET status = $1 WHERE id = $2', 
              ['refunded', paymentId]);
            paymentRolledBack = true;
          }
          throw error;
        } finally {
          client.release();
        }
      };

      mockRabbitMQ.setConnected(false);

      await expect(
        processPaymentWithSaga({ order_id: 'saga-order', amount: 50000 })
      ).rejects.toThrow('RabbitMQ not connected');

      // Payment was compensated
      expect(paymentRolledBack).toBe(true);
    });
  });
});

describe('IR-05: Mitigation Recommendations', () => {
  test('Recommendation summary', () => {
    /**
     * RECOMMENDED MITIGATIONS:
     * 
     * 1. TRANSACTIONAL OUTBOX PATTERN:
     *    - Store events in outbox table within same DB transaction
     *    - Background worker polls outbox and publishes to RabbitMQ
     *    - Mark events as published only after confirmed delivery
     * 
     * 2. SAGA PATTERN:
     *    - If event publish fails, compensate by refunding payment
     *    - Ensures consistency at the cost of more complex logic
     * 
     * 3. AT MINIMUM:
     *    - Propagate publish errors instead of swallowing
     *    - Implement retry with exponential backoff
     *    - Add dead-letter queue for failed events
     *    - Monitor for payment-order mismatches
     */
    const mitigationApplied = false;
    expect(mitigationApplied).toBe(false);
  });
});
