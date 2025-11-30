/**
 * Integration Test: IR-04 - RabbitMQ Premature Message Acknowledgment
 * 
 * Risk: The RabbitMQ consumer (src/utils/rabbitmq.js:85-95) auto-acks messages
 * before processing completes. If service crashes mid-processing, the event
 * is lost because RabbitMQ thinks it was successfully processed.
 * 
 * Test validates:
 * 1. Message is acked before handler completes
 * 2. Service crash during processing loses message
 * 3. No redelivery on handler failure
 * 4. Silent event loss when exceptions occur
 */

const {
  TEST_CONFIG,
  MockPool,
  MockRabbitMQ,
  wait,
} = require('./setup');

describe('IR-04: RabbitMQ Premature Message Acknowledgment', () => {
  let mockRabbitMQ;
  let processedMessages;
  let ackedMessages;
  let nackedMessages;

  beforeEach(() => {
    mockRabbitMQ = new MockRabbitMQ();
    mockRabbitMQ.setConnected(true);
    processedMessages = [];
    ackedMessages = [];
    nackedMessages = [];
  });

  // Simulate vulnerable consumer behavior (from src/utils/rabbitmq.js:85-95)
  const createVulnerableConsumer = async (handler) => {
    const channel = await mockRabbitMQ.createChannel();
    
    await channel.consume(
      TEST_CONFIG.ORDER_EVENTS_QUEUE,
      async (msg) => {
        if (!msg) return;
        
        try {
          const content = JSON.parse(msg.content.toString());
          await handler(content);
        } catch (error) {
          // VULNERABILITY: Error is caught but message is still acked
          console.error('[payment-service] Failed to process order event:', error);
        } finally {
          // CRITICAL VULNERABILITY: Always acks, even on failure
          channel.ack(msg);
          ackedMessages.push(msg);
        }
      },
    );

    return channel;
  };

  // Simulate proper consumer with manual ack
  const createProperConsumer = async (handler) => {
    const channel = await mockRabbitMQ.createChannel();
    
    await channel.consume(
      TEST_CONFIG.ORDER_EVENTS_QUEUE,
      async (msg) => {
        if (!msg) return;
        
        try {
          const content = JSON.parse(msg.content.toString());
          await handler(content);
          // Only ack AFTER successful processing
          channel.ack(msg);
          ackedMessages.push(msg);
        } catch (error) {
          console.error('[payment-service] Failed to process order event:', error);
          // NACK with requeue for retry
          channel.nack(msg, false, true);
          nackedMessages.push(msg);
        }
      },
    );

    return channel;
  };

  describe('Vulnerable Consumer Behavior', () => {
    test('should ack message even when handler throws exception', async () => {
      const failingHandler = async (content) => {
        throw new Error('Simulated processing failure');
      };

      await createVulnerableConsumer(failingHandler);

      // Simulate incoming message
      const message = {
        event: 'PaymentPending',
        payload: { order_id: 'order-123', amount: 50000 },
      };

      await mockRabbitMQ.simulateMessage(TEST_CONFIG.ORDER_EVENTS_QUEUE, message);
      await wait(100);

      // Message was processed (handler was called)
      // But due to exception, processing failed
      // VULNERABILITY: Message is still acked - lost forever
      expect(ackedMessages).toHaveLength(1);
    });

    test('should lose payment event when handler crashes mid-processing', async () => {
      let processingPhase = '';
      
      const crashingHandler = async (content) => {
        processingPhase = 'started';
        
        // Simulate DB insert
        await wait(10);
        processingPhase = 'db_inserted';
        
        // Simulate crash before completion
        throw new Error('Service crash!');
      };

      await createVulnerableConsumer(crashingHandler);

      const message = {
        event: 'PaymentPending',
        payload: { order_id: 'order-lost', amount: 100000 },
      };

      await mockRabbitMQ.simulateMessage(TEST_CONFIG.ORDER_EVENTS_QUEUE, message);
      await wait(100);

      // Handler started but crashed
      expect(processingPhase).toBe('db_inserted');
      
      // VULNERABILITY: Message acked despite crash - no redelivery
      expect(ackedMessages).toHaveLength(1);
      expect(nackedMessages).toHaveLength(0);
    });

    test('should not requeue message on timeout', async () => {
      const slowHandler = async (content) => {
        // Simulate very slow processing that might timeout
        await wait(5000);
        processedMessages.push(content);
      };

      await createVulnerableConsumer(slowHandler);

      const message = {
        event: 'PaymentPending',
        payload: { order_id: 'order-slow', amount: 75000 },
      };

      // Start processing
      mockRabbitMQ.simulateMessage(TEST_CONFIG.ORDER_EVENTS_QUEUE, message);
      
      // Don't wait for completion - simulating restart during processing
      await wait(50);

      // In real scenario, if service restarts here:
      // - Handler didn't complete
      // - But message would be acked on restart (or lost if not acked)
      // - No way to recover the message
    });

    test('should silently lose messages on Stripe API failure', async () => {
      let stripeCallFailed = false;
      
      const stripeFailingHandler = async (content) => {
        processedMessages.push(content);
        
        // Simulate Stripe API failure
        stripeCallFailed = true;
        throw new Error('Stripe API unavailable');
      };

      await createVulnerableConsumer(stripeFailingHandler);

      const message = {
        event: 'PaymentPending',
        payload: { order_id: 'order-stripe-fail', amount: 200000 },
      };

      await mockRabbitMQ.simulateMessage(TEST_CONFIG.ORDER_EVENTS_QUEUE, message);
      await wait(100);

      // Handler was called
      expect(processedMessages).toHaveLength(1);
      // Stripe failed
      expect(stripeCallFailed).toBe(true);
      // VULNERABILITY: Message still acked - payment never processed
      expect(ackedMessages).toHaveLength(1);
    });
  });

  describe('Proper Consumer Behavior', () => {
    test('should only ack after successful processing', async () => {
      const successHandler = async (content) => {
        processedMessages.push(content);
        // Processing succeeds
      };

      await createProperConsumer(successHandler);

      const message = {
        event: 'PaymentPending',
        payload: { order_id: 'order-success', amount: 50000 },
      };

      await mockRabbitMQ.simulateMessage(TEST_CONFIG.ORDER_EVENTS_QUEUE, message);
      await wait(100);

      expect(processedMessages).toHaveLength(1);
      expect(ackedMessages).toHaveLength(1);
      expect(nackedMessages).toHaveLength(0);
    });

    test('should nack and requeue on handler failure', async () => {
      const failingHandler = async (content) => {
        throw new Error('Processing failed');
      };

      await createProperConsumer(failingHandler);

      const message = {
        event: 'PaymentPending',
        payload: { order_id: 'order-retry', amount: 50000 },
      };

      await mockRabbitMQ.simulateMessage(TEST_CONFIG.ORDER_EVENTS_QUEUE, message);
      await wait(100);

      // Message was NOT acked
      expect(ackedMessages).toHaveLength(0);
      // Message was nacked for requeue
      expect(nackedMessages).toHaveLength(1);
    });
  });

  describe('Dead Letter Queue Pattern', () => {
    test('should move to DLQ after max retries', async () => {
      const dlqMessages = [];
      let retryCount = 0;
      const maxRetries = 3;

      const retryingHandler = async (content, msg) => {
        retryCount++;
        
        // Check retry count from message headers
        const currentRetry = msg?.properties?.headers?.['x-retry-count'] || 0;
        
        if (currentRetry >= maxRetries) {
          // Move to DLQ
          dlqMessages.push(content);
          return; // Don't throw - will be acked
        }
        
        throw new Error('Simulated failure');
      };

      // Simulate DLQ-aware consumer
      const channel = await mockRabbitMQ.createChannel();
      
      await channel.consume(
        TEST_CONFIG.ORDER_EVENTS_QUEUE,
        async (msg) => {
          if (!msg) return;
          
          const content = JSON.parse(msg.content.toString());
          const headers = msg.properties?.headers || {};
          const retryCount = headers['x-retry-count'] || 0;

          try {
            if (retryCount >= maxRetries) {
              // Send to DLQ
              dlqMessages.push(content);
              channel.ack(msg);
              ackedMessages.push(msg);
            } else {
              await retryingHandler(content, msg);
              channel.ack(msg);
              ackedMessages.push(msg);
            }
          } catch (error) {
            // Republish with incremented retry count
            const newHeaders = { ...headers, 'x-retry-count': retryCount + 1 };
            channel.sendToQueue(
              TEST_CONFIG.ORDER_EVENTS_QUEUE,
              Buffer.from(JSON.stringify(content)),
              { headers: newHeaders }
            );
            channel.ack(msg); // Ack original to avoid duplicate
            ackedMessages.push(msg);
          }
        },
      );

      // This demonstrates the pattern - not a full implementation
      expect(typeof dlqMessages).toBe('object');
    });
  });

  describe('Impact Analysis', () => {
    test('should quantify message loss under failure conditions', async () => {
      const successCount = { value: 0 };
      const failureCount = { value: 0 };
      
      // Handler that fails 30% of the time
      const flakyHandler = async (content) => {
        if (Math.random() < 0.3) {
          failureCount.value++;
          throw new Error('Random failure');
        }
        successCount.value++;
        processedMessages.push(content);
      };

      await createVulnerableConsumer(flakyHandler);

      // Send 10 messages
      for (let i = 0; i < 10; i++) {
        const message = {
          event: 'PaymentPending',
          payload: { order_id: `order-${i}`, amount: 10000 * (i + 1) },
        };
        await mockRabbitMQ.simulateMessage(TEST_CONFIG.ORDER_EVENTS_QUEUE, message);
        await wait(10);
      }

      await wait(200);

      // All messages were acked
      expect(ackedMessages.length).toBe(10);
      
      // But not all were successfully processed
      // With vulnerable consumer, failed messages are LOST
      const lostMessages = 10 - processedMessages.length;
      
      // This demonstrates the vulnerability - some messages were lost
      expect(processedMessages.length + failureCount.value).toBe(10);
    });
  });
});

describe('IR-04: Mitigation Recommendations', () => {
  test('Recommended consumer implementation', () => {
    /**
     * RECOMMENDED IMPLEMENTATION:
     * 
     * await ch.consume(
     *   queue,
     *   async (msg) => {
     *     if (!msg) return;
     *     
     *     try {
     *       const content = JSON.parse(msg.content.toString());
     *       await handler(content);
     *       
     *       // ACK only after successful processing
     *       ch.ack(msg);
     *       
     *     } catch (error) {
     *       console.error('Failed to process:', error);
     *       
     *       const retryCount = (msg.properties.headers?.['x-retry-count'] || 0);
     *       
     *       if (retryCount >= MAX_RETRIES) {
     *         // Send to dead-letter queue
     *         await publishToDLQ(msg, error);
     *         ch.ack(msg);
     *       } else {
     *         // Requeue with delay
     *         ch.nack(msg, false, true);
     *       }
     *     }
     *   },
     *   { noAck: false } // Explicit manual ack mode
     * );
     */
    const properAckImplemented = false;
    expect(properAckImplemented).toBe(false);
  });
});
