/**
 * Tests for the CacheStore — verifies that the per-key locking
 * eliminates the read-then-write race condition described in the issue.
 */

import { CacheStore } from '../cache/store.js';

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const result = Promise.resolve().then(fn);
  return result.then(
    () => console.log(`  ✓ ${name}`),
    (e: any) => {
      console.error(`  ✗ ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  );
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function runTests() {
  console.log('CacheStore tests:');

  await test('basic get returns undefined for missing keys', async () => {
    const store = new CacheStore<string>();
    const result = await store.get('missing');
    assert(result === undefined, 'Should return undefined');
  });

  await test('set then get returns the value with version 1', async () => {
    const store = new CacheStore<string>();
    const entry = await store.set('key1', 'hello');
    assert(entry.value === 'hello', 'Value should be hello');
    assert(entry.version === 1, 'First version should be 1');

    const fetched = await store.get('key1');
    assert(fetched !== undefined, 'Should exist');
    assert(fetched!.value === 'hello', 'Fetched value should be hello');
    assert(fetched!.version === 1, 'Fetched version should be 1');
  });

  await test('set increments version on each call', async () => {
    const store = new CacheStore<number>();
    await store.set('k', 1);
    await store.set('k', 2);
    const entry = await store.set('k', 3);
    assert(entry.version === 3, `Expected version 3, got ${entry.version}`);
  });

  await test('setIfVersion succeeds when version matches', async () => {
    const store = new CacheStore<string>();
    await store.set('k', 'v1'); // version 1
    const result = await store.setIfVersion('k', 'v2', 1);
    assert(result !== undefined, 'Should succeed');
    assert(result!.value === 'v2', 'Value should be updated');
    assert(result!.version === 2, 'Version should be 2');
  });

  await test('setIfVersion fails when version does not match', async () => {
    const store = new CacheStore<string>();
    await store.set('k', 'v1'); // version 1
    await store.set('k', 'v2'); // version 2
    const result = await store.setIfVersion('k', 'v3', 1); // stale version
    assert(result === undefined, 'Should return undefined on conflict');
    const current = await store.get('k');
    assert(current!.value === 'v2', 'Value should remain v2');
  });

  await test('update atomically reads and writes', async () => {
    const store = new CacheStore<number>();
    await store.set('counter', 0);
    await store.update('counter', (cur) => (cur ?? 0) + 10);
    const entry = await store.get('counter');
    assert(entry!.value === 10, 'Counter should be 10');
    assert(entry!.version === 2, 'Version should be 2 after set + update');
  });

  await test('update works on missing keys', async () => {
    const store = new CacheStore<number>();
    await store.update('new', (cur) => (cur ?? 0) + 1);
    const entry = await store.get('new');
    assert(entry !== undefined, 'Should exist');
    assert(entry!.value === 1, 'Should be 1');
    assert(entry!.version === 1, 'Version should be 1');
  });

  await test('delete removes key', async () => {
    const store = new CacheStore<string>();
    await store.set('k', 'val');
    const deleted = await store.delete('k');
    assert(deleted === true, 'Should return true');
    const entry = await store.get('k');
    assert(entry === undefined, 'Should be gone');
  });

  await test('invalidate is alias for delete', async () => {
    const store = new CacheStore<string>();
    await store.set('k', 'val');
    const result = await store.invalidate('k');
    assert(result === true, 'Should return true');
    assert((await store.get('k')) === undefined, 'Should be gone');
  });

  await test('clear removes all entries', async () => {
    const store = new CacheStore<string>();
    await store.set('a', '1');
    await store.set('b', '2');
    store.clear();
    assert(store.size === 0, 'Size should be 0');
  });

  // --- Race condition tests ---

  await test('concurrent updates to the same key are serialised', async () => {
    const store = new CacheStore<number>();
    await store.set('counter', 0);

    // Launch 50 concurrent increments
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        store.update('counter', (cur) => (cur ?? 0) + 1).then(() => {})
      );
    }
    await Promise.all(promises);

    const entry = await store.get('counter');
    assert(
      entry!.value === 50,
      `Expected 50 but got ${entry!.value} — race condition detected!`
    );
  });

  await test('concurrent set + update do not lose writes', async () => {
    const store = new CacheStore<number>();
    await store.set('val', 100);

    // Concurrent: one update doubles the value, one set overwrites to 999.
    // Both should complete without error; final value depends on order but
    // must be a consistent result of serialised execution.
    const p1 = store.update('val', (cur) => (cur ?? 0) * 2);
    const p2 = store.set('val', 999);
    await Promise.all([p1, p2]);

    const entry = await store.get('val');
    const validOutcomes = [
      999,   // update first (200), then set overwrites (999)
      1998,  // set first (999), then update doubles (1998)
    ];
    assert(
      validOutcomes.includes(entry!.value),
      `Unexpected value ${entry!.value}; expected one of ${validOutcomes}`
    );
  });

  await test('setIfVersion prevents stale overwrites', async () => {
    const store = new CacheStore<string>();
    await store.set('product', 'price=10'); // version 1

    // Simulate two concurrent readers that both read version 1
    // then try to write back. Only the first should succeed.
    const r1 = store.setIfVersion('product', 'price=20', 1);
    const r2 = store.setIfVersion('product', 'price=30', 1);
    const [res1, res2] = await Promise.all([r1, r2]);

    // Exactly one should succeed and one should fail
    const successes = [res1, res2].filter((r) => r !== undefined);
    const failures = [res1, res2].filter((r) => r === undefined);
    assert(successes.length === 1, `Expected exactly 1 success, got ${successes.length}`);
    assert(failures.length === 1, `Expected exactly 1 failure, got ${failures.length}`);

    const final = await store.get('product');
    assert(
      final!.value === 'price=20' || final!.value === 'price=30',
      `Unexpected final value: ${final!.value}`
    );
  });

  await test('independent keys are not blocked by each other', async () => {
    const store = new CacheStore<number>();

    const start = Date.now();
    await Promise.all([
      store.update('a', () => 1),
      store.update('b', () => 2),
      store.update('c', () => 3),
    ]);
    const elapsed = Date.now() - start;

    assert((await store.get('a'))!.value === 1, 'a should be 1');
    assert((await store.get('b'))!.value === 2, 'b should be 2');
    assert((await store.get('c'))!.value === 3, 'c should be 3');
    assert(elapsed < 1000, `Took too long (${elapsed}ms) — keys may be blocking`);
  });

  console.log('\nAll CacheStore tests passed!');
}

runTests();
