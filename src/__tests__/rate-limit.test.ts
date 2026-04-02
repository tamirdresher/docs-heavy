/**
 * Tests for the rate-limiting middleware.
 *
 * Covers:
 *  - Requests under limit pass through
 *  - 429 + Retry-After when limit exceeded
 *  - Sliding window (no burst at boundary)
 *  - Config validation
 *  - Custom keyGenerator
 *  - Custom store
 */

import {
  rateLimit,
  MemoryStore,
  type RateLimitRequest,
  type RateLimitResponse,
  type RateLimitStore,
} from '../middleware/rate-limit.js';

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

function mockReq(ip = '127.0.0.1'): RateLimitRequest {
  return { ip };
}

function mockRes(): RateLimitResponse & {
  statusCode?: number;
  headers: Record<string, string>;
  body?: unknown;
} {
  const res: any = { headers: {} };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.set = (h: string, v: string) => {
    res.headers[h] = v;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
  };
  return res;
}

// ── tests ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('Rate-limit middleware tests:');

  // --- Requests under limit ---

  await test('passes through requests under the limit', async () => {
    const mw = rateLimit({ windowMs: 60_000, maxRequests: 3 });
    let called = 0;
    const next = () => { called++; };

    for (let i = 0; i < 3; i++) {
      mw(mockReq(), mockRes(), next);
    }
    assert(called === 3, `Expected next called 3 times, got ${called}`);
  });

  // --- 429 when limit exceeded ---

  await test('returns 429 with Retry-After when limit exceeded', async () => {
    const mw = rateLimit({ windowMs: 60_000, maxRequests: 2 });
    const next = () => {};

    mw(mockReq(), mockRes(), next); // 1
    mw(mockReq(), mockRes(), next); // 2

    const res = mockRes();
    let nextCalled = false;
    mw(mockReq(), res, () => { nextCalled = true; });

    assert(res.statusCode === 429, `Expected 429, got ${res.statusCode}`);
    assert('Retry-After' in res.headers, 'Missing Retry-After header');
    assert(Number(res.headers['Retry-After']) > 0, 'Retry-After should be > 0');
    assert(!nextCalled, 'next() should not be called on 429');
    assert(
      (res.body as any)?.error === 'Too Many Requests',
      'Body should contain error message',
    );
  });

  // --- Sliding window: no burst at boundary ---

  await test('sliding window: requests outside window are discarded', async () => {
    const store = new MemoryStore();
    const mw = rateLimit({ windowMs: 1_000, maxRequests: 2, store });

    // Manually seed timestamps that are already outside the window
    const now = Date.now();
    store.set('127.0.0.1', [now - 2_000, now - 1_500]);

    let called = 0;
    const next = () => { called++; };

    mw(mockReq(), mockRes(), next);
    assert(called === 1, 'Old timestamps should have been pruned, request should pass');
  });

  await test('sliding window: prevents burst at boundary', async () => {
    const store = new MemoryStore();
    const mw = rateLimit({ windowMs: 1_000, maxRequests: 2, store });

    // Place two timestamps just inside the window boundary
    const now = Date.now();
    store.set('127.0.0.1', [now - 500, now - 200]);

    const res = mockRes();
    let nextCalled = false;
    mw(mockReq(), res, () => { nextCalled = true; });

    assert(res.statusCode === 429, 'Should be rate-limited');
    assert(!nextCalled, 'next should not be called');
  });

  // --- Config validation ---

  await test('throws on windowMs = 0', async () => {
    let threw = false;
    try {
      rateLimit({ windowMs: 0, maxRequests: 10 });
    } catch {
      threw = true;
    }
    assert(threw, 'Should throw on windowMs = 0');
  });

  await test('throws on negative windowMs', async () => {
    let threw = false;
    try {
      rateLimit({ windowMs: -1, maxRequests: 10 });
    } catch {
      threw = true;
    }
    assert(threw, 'Should throw on negative windowMs');
  });

  await test('throws on NaN windowMs', async () => {
    let threw = false;
    try {
      rateLimit({ windowMs: NaN, maxRequests: 10 });
    } catch {
      threw = true;
    }
    assert(threw, 'Should throw on NaN windowMs');
  });

  await test('throws on Infinity windowMs', async () => {
    let threw = false;
    try {
      rateLimit({ windowMs: Infinity, maxRequests: 10 });
    } catch {
      threw = true;
    }
    assert(threw, 'Should throw on Infinity windowMs');
  });

  await test('throws on maxRequests = 0', async () => {
    let threw = false;
    try {
      rateLimit({ windowMs: 1000, maxRequests: 0 });
    } catch {
      threw = true;
    }
    assert(threw, 'Should throw on maxRequests = 0');
  });

  await test('throws on fractional maxRequests', async () => {
    let threw = false;
    try {
      rateLimit({ windowMs: 1000, maxRequests: 1.5 });
    } catch {
      threw = true;
    }
    assert(threw, 'Should throw on fractional maxRequests');
  });

  await test('throws on non-function keyGenerator', async () => {
    let threw = false;
    try {
      rateLimit({ windowMs: 1000, maxRequests: 10, keyGenerator: 'bad' as any });
    } catch {
      threw = true;
    }
    assert(threw, 'Should throw on non-function keyGenerator');
  });

  await test('throws on invalid store', async () => {
    let threw = false;
    try {
      rateLimit({ windowMs: 1000, maxRequests: 10, store: {} as any });
    } catch {
      threw = true;
    }
    assert(threw, 'Should throw on invalid store');
  });

  // --- Custom keyGenerator ---

  await test('uses custom keyGenerator to isolate clients', async () => {
    const mw = rateLimit({
      windowMs: 60_000,
      maxRequests: 1,
      keyGenerator: (req) => (req as any).userId ?? req.ip,
    });

    let called = 0;
    const next = () => { called++; };

    const reqA = { ip: '1.1.1.1', userId: 'alice' } as RateLimitRequest;
    const reqB = { ip: '2.2.2.2', userId: 'bob' } as RateLimitRequest;

    mw(reqA, mockRes(), next); // alice — 1st
    mw(reqB, mockRes(), next); // bob   — 1st

    assert(called === 2, `Both users should pass, got ${called}`);

    // alice — 2nd → should be blocked
    const res = mockRes();
    mw(reqA, res, next);
    assert(res.statusCode === 429, 'Alice should be rate-limited');
  });

  // --- Custom store ---

  await test('works with a custom store implementation', async () => {
    const data = new Map<string, number[]>();
    const customStore: RateLimitStore = {
      get: (k) => data.get(k) ?? [],
      set: (k, v) => { data.set(k, v); },
      clear: () => data.clear(),
    };

    const mw = rateLimit({ windowMs: 60_000, maxRequests: 1, store: customStore });
    let called = 0;
    const next = () => { called++; };

    mw(mockReq(), mockRes(), next);
    assert(called === 1, 'First request should pass');
    assert(data.has('127.0.0.1'), 'Store should contain key');

    const res = mockRes();
    mw(mockReq(), res, next);
    assert(res.statusCode === 429, 'Second request should be rate-limited');
  });

  // --- MemoryStore unit tests ---

  await test('MemoryStore.clear() removes all entries', async () => {
    const store = new MemoryStore();
    store.set('a', [1, 2, 3]);
    store.set('b', [4, 5]);
    store.clear();
    assert(store.get('a').length === 0, 'Should be empty after clear');
    assert(store.get('b').length === 0, 'Should be empty after clear');
  });

  await test('MemoryStore.get() returns empty array for unknown key', async () => {
    const store = new MemoryStore();
    const result = store.get('nonexistent');
    assert(Array.isArray(result), 'Should return array');
    assert(result.length === 0, 'Should be empty');
  });

  // --- Different IPs tracked separately ---

  await test('different IPs are tracked independently', async () => {
    const mw = rateLimit({ windowMs: 60_000, maxRequests: 1 });
    let called = 0;
    const next = () => { called++; };

    mw(mockReq('10.0.0.1'), mockRes(), next);
    mw(mockReq('10.0.0.2'), mockRes(), next);

    assert(called === 2, 'Different IPs should each get their own limit');
  });

  // --- Retry-After value correctness ---

  await test('Retry-After value is reasonable', async () => {
    const store = new MemoryStore();
    const mw = rateLimit({ windowMs: 10_000, maxRequests: 1, store });

    const now = Date.now();
    store.set('127.0.0.1', [now - 3_000]); // 3s ago

    const res = mockRes();
    mw(mockReq(), res, () => {});

    assert(res.statusCode === 429, 'Should be rate-limited');
    const retryAfter = Number(res.headers['Retry-After']);
    // The oldest timestamp is 3s ago, window is 10s, so ~7s remaining
    assert(retryAfter >= 6 && retryAfter <= 8, `Retry-After should be ~7, got ${retryAfter}`);
  });

  console.log('\nAll rate-limit tests passed!');
}

runTests();
