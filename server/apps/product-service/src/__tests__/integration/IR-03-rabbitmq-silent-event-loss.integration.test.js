/**
 * Integration Test: IR-03 - RabbitMQ Silent Event Loss
 * 
 * Risk: rabbitmq.js:53-56 only logs error when channel is null
 *       Socket events are silently dropped without any retry or notification
 * 
 * Impact: HIGH - Real-time updates lost, UI out of sync with DB state
 * 
 * Target Code (rabbitmq.js:53-56):
 * ```javascript
 * const publishSocketEvent = (event, payload, rooms = []) => {
 *   if (!channel) {
 *     console.error('[product-service] RabbitMQ channel not ready; skipping socket event:', event);
 *     return;  // Silent failure - no throw, no retry!
 *   }
 *   // ...
 * };
 * ```
 * 
 * Reproduction:
 *   docker stop rabbitmq
 *   # Create restaurant - events will be silently dropped
 */

describe('IR-03: RabbitMQ Silent Event Loss', () => {
  let originalConsoleError;
  let consoleErrorCalls;

  beforeEach(() => {
    jest.resetModules();

    // Capture console.error calls
    consoleErrorCalls = [];
    originalConsoleError = console.error;
    console.error = (...args) => {
      consoleErrorCalls.push(args);
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
    jest.clearAllMocks();
  });

  describe('Channel Null Behavior', () => {
    test('VULNERABILITY: publishSocketEvent silently fails when channel is null', () => {
      // Simulate channel being null (RabbitMQ not connected)
      jest.doMock('amqplib', () => ({
        connect: jest.fn().mockRejectedValue(new Error('Connection refused')),
      }));

      // Import rabbitmq module (channel will be null)
      const rabbitmq = require('../../utils/rabbitmq');

      // Attempt to publish event - should silently fail
      const result = rabbitmq.publishSocketEvent(
        'restaurant.created',
        { restaurant: { id: 'rest-123', name: 'Test' } },
        ['admin:restaurants']
      );

      // No error thrown - silent failure
      expect(result).toBeUndefined();

      // Only logged to console
      expect(consoleErrorCalls.some((call) =>
        call[0].includes('RabbitMQ channel not ready')
      )).toBe(true);
    });

    test('VULNERABILITY: Multiple events lost without notification', () => {
      jest.doMock('amqplib', () => ({
        connect: jest.fn().mockRejectedValue(new Error('Connection refused')),
      }));

      const rabbitmq = require('../../utils/rabbitmq');

      const events = [
        { event: 'restaurant.created', payload: { id: 'r1' } },
        { event: 'restaurant.branch.created', payload: { id: 'b1' } },
        { event: 'menu.product.created', payload: { id: 'p1' } },
        { event: 'menu.category.created', payload: { id: 'c1' } },
      ];

      // All events silently dropped
      events.forEach(({ event, payload }) => {
        rabbitmq.publishSocketEvent(event, payload, ['some-room']);
      });

      // No errors thrown, but all events lost
      const channelNotReadyLogs = consoleErrorCalls.filter((call) =>
        call[0].includes('RabbitMQ channel not ready')
      );

      expect(channelNotReadyLogs.length).toBe(events.length);
    });

    test('SCENARIO: Restaurant created but socket event lost', async () => {
      // Simulate RabbitMQ down
      const mockChannel = null;

      jest.doMock('../../utils/rabbitmq', () => ({
        connectRabbitMQ: jest.fn().mockRejectedValue(new Error('Connection refused')),
        publishSocketEvent: jest.fn((event, payload, rooms) => {
          if (!mockChannel) {
            console.error('[product-service] RabbitMQ channel not ready; skipping socket event:', event);
            return; // Silent failure
          }
        }),
      }));

      const { publishSocketEvent } = require('../../utils/rabbitmq');

      // Simulate restaurant service calling publishSocketEvent
      const restaurant = {
        id: 'rest-123',
        name: 'New Restaurant',
        owner_user_id: 'owner-123',
      };

      publishSocketEvent(
        'restaurant.created',
        { restaurant, branches: [], ownerUserId: 'owner-123' },
        ['admin:restaurants', 'restaurant-owner:owner-123']
      );

      // Event was called but silently failed
      expect(publishSocketEvent).toHaveBeenCalled();

      // In real scenario:
      // - Restaurant saved to DB ✓
      // - Admin dashboard not notified ✗
      // - Owner not notified ✗
    });
  });

  describe('Impact Analysis', () => {
    test('IMPACT: Admin dashboard shows stale data', () => {
      // When events are lost, admin dashboard won't receive real-time updates
      // Users have to manually refresh to see new restaurants/products

      const lostEvents = [];

      jest.doMock('../../utils/rabbitmq', () => ({
        publishSocketEvent: (event, payload, rooms) => {
          // Simulate channel down
          lostEvents.push({ event, payload, rooms, timestamp: new Date() });
          console.error('[product-service] RabbitMQ channel not ready; skipping socket event:', event);
        },
      }));

      const { publishSocketEvent } = require('../../utils/rabbitmq');

      // Series of events that would be lost
      publishSocketEvent('restaurant.created', { id: 'r1' }, ['admin:restaurants']);
      publishSocketEvent('menu.product.created', { id: 'p1' }, ['restaurant:r1']);
      publishSocketEvent('menu.category.created', { id: 'c1' }, ['restaurant:r1']);

      expect(lostEvents.length).toBe(3);
      // All these updates won't appear in real-time on connected clients
    });

    test('IMPACT: Order service may use stale catalog data', () => {
      // When catalog updates are lost, order service may not know about:
      // - New products
      // - Price changes
      // - Availability changes

      const catalogUpdateEvents = [
        { event: 'menu.product.price.updated', payload: { productId: 'p1', newPrice: 15.99 } },
        { event: 'menu.product.availability.updated', payload: { productId: 'p2', available: false } },
      ];

      jest.doMock('../../utils/rabbitmq', () => ({
        publishSocketEvent: () => {
          // Silent failure
        },
      }));

      const { publishSocketEvent } = require('../../utils/rabbitmq');

      catalogUpdateEvents.forEach(({ event, payload }) => {
        publishSocketEvent(event, payload, ['catalog:products']);
      });

      // Order service won't know about price/availability changes
      // Customers may order unavailable products at wrong prices
    });
  });

  describe('What Should Happen', () => {
    test('EXPECTED: Event loss should throw or return error indicator', () => {
      // Better implementation would return success/failure
      const improvedPublishSocketEvent = (event, payload, rooms) => {
        const channel = null; // Simulate disconnected

        if (!channel) {
          const error = new Error(`Failed to publish event: ${event} - channel not ready`);
          error.event = event;
          error.payload = payload;
          throw error;
        }

        return { success: true, event };
      };

      expect(() => {
        improvedPublishSocketEvent('restaurant.created', { id: 'r1' }, []);
      }).toThrow('Failed to publish event');
    });

    test('EXPECTED: Event queueing for retry when channel reconnects', async () => {
      const pendingEvents = [];
      let channel = null;

      const queuedPublishSocketEvent = (event, payload, rooms) => {
        if (!channel) {
          // Queue for later retry
          pendingEvents.push({ event, payload, rooms, queuedAt: new Date() });
          console.warn('[rabbitmq] Event queued for retry:', event);
          return { queued: true };
        }

        return { sent: true };
      };

      // Queue events while disconnected
      queuedPublishSocketEvent('restaurant.created', { id: 'r1' }, []);
      queuedPublishSocketEvent('menu.product.created', { id: 'p1' }, []);

      expect(pendingEvents.length).toBe(2);

      // Simulate reconnection
      channel = {}; // Mock channel
      const flushQueue = () => {
        const events = [...pendingEvents];
        pendingEvents.length = 0;
        return events.map((e) => ({ ...e, sent: true }));
      };

      const sentEvents = flushQueue();
      expect(sentEvents.length).toBe(2);
      expect(pendingEvents.length).toBe(0);
    });
  });
});

/**
 * REMEDIATION:
 * 
 * Option 1: Throw error on publish failure (let caller handle)
 * 
 * ```javascript
 * const publishSocketEvent = (event, payload, rooms = []) => {
 *   if (!channel) {
 *     const error = new Error(`Failed to publish socket event: ${event}`);
 *     error.code = 'RABBITMQ_CHANNEL_NOT_READY';
 *     error.event = event;
 *     throw error;
 *   }
 *   // ... rest of implementation
 * };
 * ```
 * 
 * Option 2: Queue events for retry when connection restored
 * 
 * ```javascript
 * const pendingEvents = [];
 * const MAX_PENDING = 1000;
 * 
 * const publishSocketEvent = (event, payload, rooms = []) => {
 *   const message = { event, payload, rooms, timestamp: Date.now() };
 * 
 *   if (!channel) {
 *     if (pendingEvents.length < MAX_PENDING) {
 *       pendingEvents.push(message);
 *       console.warn(`[rabbitmq] Event queued: ${event} (${pendingEvents.length} pending)`);
 *     } else {
 *       console.error(`[rabbitmq] Event dropped: ${event} (queue full)`);
 *     }
 *     return { queued: true };
 *   }
 * 
 *   channel.sendToQueue(SOCKET_QUEUE, Buffer.from(JSON.stringify(message)));
 *   return { sent: true };
 * };
 * 
 * // Flush queue on reconnection
 * connection.on('ready', () => {
 *   console.log(`[rabbitmq] Flushing ${pendingEvents.length} pending events`);
 *   while (pendingEvents.length) {
 *     const msg = pendingEvents.shift();
 *     channel.sendToQueue(SOCKET_QUEUE, Buffer.from(JSON.stringify(msg)));
 *   }
 * });
 * ```
 * 
 * Option 3: Use outbox pattern - store events in DB for reliable delivery
 */
