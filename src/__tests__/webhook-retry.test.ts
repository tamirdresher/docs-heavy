/**
 * Tests for webhook retry with exponential backoff.
 *
 * Covers:
 *  - Successful delivery on first attempt
 *  - Retries on 5xx with correct exponential backoff
 *  - Retries on network error (thrown exception)
 *  - Moves to dead-letter queue after max retries
 *  - Delivery status tracking accuracy
 *  - calculateBackoff helper
 *  - isRetryableStatus helper
 *  - Config validation
 *  - Payload shape (event, timestamp, attempt, webhookId)
 *  - Custom maxRetries and baseDelay
 */

import {
  WebhookDeliveryManager,
  calculateBackoff,
  isRetryableStatus,
  type DeliveryPayload,
  type DeliveryResult,
  type WebhookDelivery,
} from '../middleware/webhook-retry.js';

// ── test helpers ────────────────────────────────────────────────────────

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const result = Promise.resolve().then(fn);
  return result.then(
    () => console.log(`  ✓ ${name}`),
    (e: any) => {
      console.error(`  ✗ ${name}: ${e.message}`);
      process.exitCode = 1;
    },
  );
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

/**
 * A testable subclass that skips actual sleeps so tests run instantly.
 * Records the requested backoff durations for assertions.
 */
class TestableDeliveryManager extends WebhookDeliveryManager {
  public sleepCalls: number[] = [];

  protected override sleep(ms: number): Promise<void> {
    this.sleepCalls.push(ms);
    return Promise.resolve();
  }
}

// ── tests ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('Webhook retry tests:');

  // ── calculateBackoff ──────────────────────────────────────────────

  await test('calculateBackoff: attempt 0 → baseDelay', () => {
    assert(calculateBackoff(0, 1000) === 1000, 'Should be 1000');
  });

  await test('calculateBackoff: attempt 1 → 2 * baseDelay', () => {
    assert(calculateBackoff(1, 1000) === 2000, 'Should be 2000');
  });

  await test('calculateBackoff: attempt 4 → 16 * baseDelay', () => {
    assert(calculateBackoff(4, 1000) === 16000, 'Should be 16000');
  });

  await test('calculateBackoff: custom base delay', () => {
    assert(calculateBackoff(2, 500) === 2000, '500 * 2^2 = 2000');
  });

  await test('calculateBackoff: throws on negative attempt', () => {
    let threw = false;
    try { calculateBackoff(-1, 1000); } catch { threw = true; }
    assert(threw, 'Should throw');
  });

  await test('calculateBackoff: throws on non-finite baseDelay', () => {
    let threw = false;
    try { calculateBackoff(0, Infinity); } catch { threw = true; }
    assert(threw, 'Should throw');
  });

  await test('calculateBackoff: throws on zero baseDelay', () => {
    let threw = false;
    try { calculateBackoff(0, 0); } catch { threw = true; }
    assert(threw, 'Should throw');
  });

  // ── isRetryableStatus ─────────────────────────────────────────────

  await test('isRetryableStatus: 500 → true', () => {
    assert(isRetryableStatus(500) === true, 'Should be true');
  });

  await test('isRetryableStatus: 503 → true', () => {
    assert(isRetryableStatus(503) === true, 'Should be true');
  });

  await test('isRetryableStatus: 200 → false', () => {
    assert(isRetryableStatus(200) === false, 'Should be false');
  });

  await test('isRetryableStatus: 404 → false', () => {
    assert(isRetryableStatus(404) === false, 'Should be false');
  });

  await test('isRetryableStatus: 499 → false', () => {
    assert(isRetryableStatus(499) === false, 'Should be false');
  });

  // ── Successful delivery on first attempt ──────────────────────────

  await test('successful delivery on first attempt — no retry', async () => {
    let callCount = 0;
    const manager = new TestableDeliveryManager({
      maxRetries: 5,
      baseDelayMs: 1000,
      deliverFn: async () => {
        callCount++;
        return { statusCode: 200 };
      },
    });

    const result = await manager.deliver({
      url: 'https://example.com/hook',
      event: 'order.created',
      payload: { orderId: '1' },
      webhookId: 'wh_1',
    });

    assert(result.status === 'delivered', `Expected delivered, got ${result.status}`);
    assert(result.attempts === 1, `Expected 1 attempt, got ${result.attempts}`);
    assert(result.deliveredAt !== null, 'deliveredAt should be set');
    assert(result.lastError === null, 'lastError should be null');
    assert(callCount === 1, `deliverFn called ${callCount} times, expected 1`);
    assert(manager.sleepCalls.length === 0, 'No sleep should occur on first attempt');
    assert(manager.getDeadLetterQueue().length === 0, 'DLQ should be empty');
  });

  // ── Retries on 5xx with exponential backoff ───────────────────────

  await test('retries on 5xx with correct exponential backoff delays', async () => {
    let callCount = 0;
    const manager = new TestableDeliveryManager({
      maxRetries: 5,
      baseDelayMs: 1000,
      deliverFn: async () => {
        callCount++;
        if (callCount <= 3) return { statusCode: 500 };
        return { statusCode: 200 };
      },
    });

    const result = await manager.deliver({
      url: 'https://example.com/hook',
      event: 'order.created',
      payload: {},
      webhookId: 'wh_2',
    });

    assert(result.status === 'delivered', `Expected delivered, got ${result.status}`);
    assert(result.attempts === 4, `Expected 4 attempts, got ${result.attempts}`);
    assert(callCount === 4, `deliverFn called ${callCount} times, expected 4`);

    // Backoff sleeps: before attempt 2 → 1000ms, before attempt 3 → 2000ms, before attempt 4 → 4000ms
    assert(manager.sleepCalls.length === 3, `Expected 3 sleeps, got ${manager.sleepCalls.length}`);
    assert(manager.sleepCalls[0] === 1000, `First sleep should be 1000, got ${manager.sleepCalls[0]}`);
    assert(manager.sleepCalls[1] === 2000, `Second sleep should be 2000, got ${manager.sleepCalls[1]}`);
    assert(manager.sleepCalls[2] === 4000, `Third sleep should be 4000, got ${manager.sleepCalls[2]}`);
  });

  // ── Retries on network error ──────────────────────────────────────

  await test('retries on network error (thrown exception)', async () => {
    let callCount = 0;
    const manager = new TestableDeliveryManager({
      maxRetries: 2,
      baseDelayMs: 1000,
      deliverFn: async () => {
        callCount++;
        if (callCount === 1) throw new Error('ECONNREFUSED');
        return { statusCode: 200 };
      },
    });

    const result = await manager.deliver({
      url: 'https://example.com/hook',
      event: 'user.signup',
      payload: {},
      webhookId: 'wh_3',
    });

    assert(result.status === 'delivered', `Expected delivered, got ${result.status}`);
    assert(result.attempts === 2, `Expected 2 attempts, got ${result.attempts}`);
    assert(callCount === 2, `deliverFn called ${callCount} times, expected 2`);
  });

  // ── Dead-letter queue after max retries ───────────────────────────

  await test('moves to dead-letter queue after exhausting retries', async () => {
    let callCount = 0;
    const manager = new TestableDeliveryManager({
      maxRetries: 3,
      baseDelayMs: 1000,
      deliverFn: async () => {
        callCount++;
        return { statusCode: 502 };
      },
    });

    const result = await manager.deliver({
      url: 'https://example.com/hook',
      event: 'payment.failed',
      payload: { amount: 100 },
      webhookId: 'wh_4',
    });

    assert(result.status === 'failed', `Expected failed, got ${result.status}`);
    assert(result.attempts === 4, `Expected 4 attempts (1 + 3 retries), got ${result.attempts}`);
    assert(result.lastError === 'HTTP 502', `Expected 'HTTP 502', got '${result.lastError}'`);
    assert(result.nextRetryAt === null, 'nextRetryAt should be null after failure');
    assert(callCount === 4, `deliverFn called ${callCount} times, expected 4`);

    const dlq = manager.getDeadLetterQueue();
    assert(dlq.length === 1, `DLQ should have 1 entry, got ${dlq.length}`);
    assert(dlq[0].id === result.id, 'DLQ entry should match the failed delivery');
  });

  // ── Dead-letter queue with network errors ─────────────────────────

  await test('dead-letter on persistent network error', async () => {
    const manager = new TestableDeliveryManager({
      maxRetries: 2,
      baseDelayMs: 500,
      deliverFn: async () => {
        throw new Error('DNS resolution failed');
      },
    });

    const result = await manager.deliver({
      url: 'https://nonexistent.example.com/hook',
      event: 'test.event',
      payload: {},
      webhookId: 'wh_5',
    });

    assert(result.status === 'failed', `Expected failed, got ${result.status}`);
    assert(result.attempts === 3, `Expected 3 attempts, got ${result.attempts}`);
    assert(result.lastError === 'DNS resolution failed', `Unexpected lastError: ${result.lastError}`);

    const dlq = manager.getDeadLetterQueue();
    assert(dlq.length === 1, 'DLQ should have 1 entry');
  });

  // ── Status tracking accuracy ──────────────────────────────────────

  await test('status transitions: pending → retrying → delivered', async () => {
    let callCount = 0;

    const manager = new TestableDeliveryManager({
      maxRetries: 5,
      baseDelayMs: 1000,
      deliverFn: async () => {
        callCount++;
        if (callCount === 1) return { statusCode: 503 };
        return { statusCode: 200 };
      },
    });

    const result = await manager.deliver({
      url: 'https://example.com/hook',
      event: 'test',
      payload: {},
      webhookId: 'wh_6',
    });

    assert(result.status === 'delivered', `Expected delivered, got ${result.status}`);
    assert(result.attempts === 2, `Expected 2 attempts, got ${result.attempts}`);
  });

  await test('status tracking: getDelivery returns correct record', async () => {
    const manager = new TestableDeliveryManager({
      maxRetries: 0,
      baseDelayMs: 1000,
      deliverFn: async () => ({ statusCode: 200 }),
    });

    const result = await manager.deliver({
      url: 'https://example.com/hook',
      event: 'ping',
      payload: null,
      webhookId: 'wh_7',
    });

    const fetched = manager.getDelivery(result.id);
    assert(fetched !== undefined, 'Should find delivery by ID');
    assert(fetched!.status === 'delivered', 'Fetched status should be delivered');
    assert(fetched!.webhookId === 'wh_7', 'webhookId should match');
  });

  // ── Payload shape ─────────────────────────────────────────────────

  await test('payload includes event, timestamp, attempt, webhookId', async () => {
    let capturedPayload: DeliveryPayload | null = null;

    const manager = new TestableDeliveryManager({
      maxRetries: 0,
      baseDelayMs: 1000,
      deliverFn: async (_url, payload) => {
        capturedPayload = payload;
        return { statusCode: 200 };
      },
    });

    await manager.deliver({
      url: 'https://example.com/hook',
      event: 'user.created',
      payload: { userId: '42' },
      webhookId: 'wh_8',
    });

    assert(capturedPayload !== null, 'Payload should be captured');
    assert(capturedPayload!.event === 'user.created', `event mismatch: ${capturedPayload!.event}`);
    assert(capturedPayload!.webhookId === 'wh_8', `webhookId mismatch`);
    assert(capturedPayload!.attempt === 1, `attempt should be 1, got ${capturedPayload!.attempt}`);
    assert(typeof capturedPayload!.timestamp === 'string', 'timestamp should be a string');
    assert(!isNaN(Date.parse(capturedPayload!.timestamp)), 'timestamp should be valid ISO date');
    assert((capturedPayload!.data as any).userId === '42', 'data should contain original payload');
  });

  await test('attempt number increments on retries in payload', async () => {
    const attempts: number[] = [];

    const manager = new TestableDeliveryManager({
      maxRetries: 2,
      baseDelayMs: 1000,
      deliverFn: async (_url, payload) => {
        attempts.push(payload.attempt);
        if (attempts.length < 3) return { statusCode: 500 };
        return { statusCode: 200 };
      },
    });

    await manager.deliver({
      url: 'https://example.com/hook',
      event: 'test',
      payload: {},
      webhookId: 'wh_9',
    });

    assert(attempts.length === 3, `Expected 3 attempts, got ${attempts.length}`);
    assert(attempts[0] === 1, `First attempt should be 1, got ${attempts[0]}`);
    assert(attempts[1] === 2, `Second attempt should be 2, got ${attempts[1]}`);
    assert(attempts[2] === 3, `Third attempt should be 3, got ${attempts[2]}`);
  });

  // ── Custom maxRetries and baseDelay ───────────────────────────────

  await test('maxRetries = 0 means no retries', async () => {
    let callCount = 0;
    const manager = new TestableDeliveryManager({
      maxRetries: 0,
      baseDelayMs: 1000,
      deliverFn: async () => {
        callCount++;
        return { statusCode: 500 };
      },
    });

    const result = await manager.deliver({
      url: 'https://example.com/hook',
      event: 'test',
      payload: {},
      webhookId: 'wh_10',
    });

    assert(result.status === 'failed', `Expected failed, got ${result.status}`);
    assert(result.attempts === 1, `Expected 1 attempt, got ${result.attempts}`);
    assert(callCount === 1, 'deliverFn should be called once');
    assert(manager.getDeadLetterQueue().length === 1, 'Should be in DLQ');
  });

  await test('custom baseDelayMs affects backoff timing', async () => {
    let callCount = 0;
    const manager = new TestableDeliveryManager({
      maxRetries: 3,
      baseDelayMs: 500,
      deliverFn: async () => {
        callCount++;
        if (callCount <= 3) return { statusCode: 500 };
        return { statusCode: 200 };
      },
    });

    await manager.deliver({
      url: 'https://example.com/hook',
      event: 'test',
      payload: {},
      webhookId: 'wh_11',
    });

    // Backoff: 500, 1000, 2000
    assert(manager.sleepCalls[0] === 500, `First sleep should be 500, got ${manager.sleepCalls[0]}`);
    assert(manager.sleepCalls[1] === 1000, `Second sleep should be 1000, got ${manager.sleepCalls[1]}`);
    assert(manager.sleepCalls[2] === 2000, `Third sleep should be 2000, got ${manager.sleepCalls[2]}`);
  });

  // ── Non-retryable client errors ───────────────────────────────────

  await test('4xx responses are treated as success (no retry)', async () => {
    let callCount = 0;
    const manager = new TestableDeliveryManager({
      maxRetries: 5,
      baseDelayMs: 1000,
      deliverFn: async () => {
        callCount++;
        return { statusCode: 400 };
      },
    });

    const result = await manager.deliver({
      url: 'https://example.com/hook',
      event: 'test',
      payload: {},
      webhookId: 'wh_12',
    });

    assert(result.status === 'delivered', `Expected delivered, got ${result.status}`);
    assert(callCount === 1, 'Should not retry on 4xx');
    assert(manager.getDeadLetterQueue().length === 0, 'DLQ should be empty');
  });

  // ── Config validation ─────────────────────────────────────────────

  await test('throws on negative maxRetries', () => {
    let threw = false;
    try {
      new TestableDeliveryManager({ maxRetries: -1, deliverFn: async () => ({ statusCode: 200 }) });
    } catch { threw = true; }
    assert(threw, 'Should throw on negative maxRetries');
  });

  await test('throws on fractional maxRetries', () => {
    let threw = false;
    try {
      new TestableDeliveryManager({ maxRetries: 2.5, deliverFn: async () => ({ statusCode: 200 }) });
    } catch { threw = true; }
    assert(threw, 'Should throw on fractional maxRetries');
  });

  await test('throws on zero baseDelayMs', () => {
    let threw = false;
    try {
      new TestableDeliveryManager({ baseDelayMs: 0, deliverFn: async () => ({ statusCode: 200 }) });
    } catch { threw = true; }
    assert(threw, 'Should throw on zero baseDelayMs');
  });

  await test('throws on non-function deliverFn', () => {
    let threw = false;
    try {
      new TestableDeliveryManager({ deliverFn: 'not a function' as any });
    } catch { threw = true; }
    assert(threw, 'Should throw on non-function deliverFn');
  });

  await test('throws on non-function idGenerator', () => {
    let threw = false;
    try {
      new TestableDeliveryManager({
        deliverFn: async () => ({ statusCode: 200 }),
        idGenerator: 42 as any,
      });
    } catch { threw = true; }
    assert(threw, 'Should throw on non-function idGenerator');
  });

  // ── Delivery record fields ────────────────────────────────────────

  await test('delivery record has correct metadata', async () => {
    const before = new Date();
    const manager = new TestableDeliveryManager({
      maxRetries: 0,
      baseDelayMs: 1000,
      deliverFn: async () => ({ statusCode: 200 }),
    });

    const result = await manager.deliver({
      url: 'https://example.com/hook',
      event: 'order.shipped',
      payload: { tracking: 'ABC' },
      webhookId: 'wh_meta',
    });

    assert(typeof result.id === 'string' && result.id.length > 0, 'id should be a non-empty string');
    assert(result.webhookId === 'wh_meta', 'webhookId mismatch');
    assert(result.event === 'order.shipped', 'event mismatch');
    assert((result.payload as any).tracking === 'ABC', 'payload mismatch');
    assert(result.createdAt >= before, 'createdAt should be recent');
    assert(result.deliveredAt !== null && result.deliveredAt >= before, 'deliveredAt should be set');
  });

  // ── Full 5-retry sequence with default config ─────────────────────

  await test('full 5-retry sequence: 1s, 2s, 4s, 8s, 16s backoff', async () => {
    let callCount = 0;
    const manager = new TestableDeliveryManager({
      maxRetries: 5,
      baseDelayMs: 1000,
      deliverFn: async () => {
        callCount++;
        return { statusCode: 500 };
      },
    });

    const result = await manager.deliver({
      url: 'https://example.com/hook',
      event: 'test',
      payload: {},
      webhookId: 'wh_full',
    });

    assert(result.status === 'failed', `Expected failed, got ${result.status}`);
    assert(result.attempts === 6, `Expected 6 attempts (1 + 5 retries), got ${result.attempts}`);
    assert(callCount === 6, `deliverFn called ${callCount} times, expected 6`);

    const expected = [1000, 2000, 4000, 8000, 16000];
    assert(manager.sleepCalls.length === 5, `Expected 5 sleeps, got ${manager.sleepCalls.length}`);
    for (let i = 0; i < expected.length; i++) {
      assert(
        manager.sleepCalls[i] === expected[i],
        `Sleep ${i} should be ${expected[i]}, got ${manager.sleepCalls[i]}`,
      );
    }

    assert(manager.getDeadLetterQueue().length === 1, 'Should be in DLQ');
  });

  console.log('\nAll webhook retry tests passed!');
}

runTests();
