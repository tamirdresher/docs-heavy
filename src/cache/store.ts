/**
 * Cache store with atomic read-then-write operations.
 *
 * The previous implementation used a naive get/set pattern that was
 * vulnerable to race conditions under concurrent load:
 *
 *   const current = await cache.get(key);   // Thread A reads
 *   // ... Thread B writes + invalidates ...
 *   await cache.set(key, updated);           // Thread A writes stale data back
 *
 * This module fixes the issue by providing:
 *   1. A per-key lock mechanism so concurrent updates to the same key
 *      are serialised, preventing stale overwrites.
 *   2. An `update` method that atomically reads, transforms, and writes
 *      within a single lock scope.
 *   3. Version stamping so callers can detect conflicts with `setIfVersion`.
 */

export interface CacheEntry<T = unknown> {
  value: T;
  version: number;
}

type ReleaseFn = () => void;

/**
 * Simple per-key mutex.  Callers acquire the lock for a key, perform
 * their work, then release.  Subsequent acquires on the same key queue
 * behind the current holder.
 */
class KeyLock {
  private locks = new Map<string, Promise<void>>();
  private resolvers = new Map<string, ReleaseFn>();

  async acquire(key: string): Promise<ReleaseFn> {
    // Wait for any existing lock on this key to be released
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    // Set up a new lock for this key
    let release!: ReleaseFn;
    const lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(key, lockPromise);
    this.resolvers.set(key, release);

    return () => {
      this.locks.delete(key);
      this.resolvers.delete(key);
      release();
    };
  }
}

export class CacheStore<T = unknown> {
  private data = new Map<string, CacheEntry<T>>();
  private keyLock = new KeyLock();

  /** Read a value (no lock needed for a simple read). */
  async get(key: string): Promise<CacheEntry<T> | undefined> {
    return this.data.get(key);
  }

  /**
   * Unconditional set — overwrites whatever is there.
   * Acquires the key lock so it does not interleave with an `update`.
   */
  async set(key: string, value: T): Promise<CacheEntry<T>> {
    const release = await this.keyLock.acquire(key);
    try {
      const existing = this.data.get(key);
      const version = (existing?.version ?? 0) + 1;
      const entry: CacheEntry<T> = { value, version };
      this.data.set(key, entry);
      return entry;
    } finally {
      release();
    }
  }

  /**
   * Conditional set — only writes if the current version matches
   * `expectedVersion`.  Returns the new entry on success, or `undefined`
   * if the version has moved on (i.e. another writer got there first).
   */
  async setIfVersion(
    key: string,
    value: T,
    expectedVersion: number
  ): Promise<CacheEntry<T> | undefined> {
    const release = await this.keyLock.acquire(key);
    try {
      const existing = this.data.get(key);
      const currentVersion = existing?.version ?? 0;
      if (currentVersion !== expectedVersion) {
        return undefined; // conflict — caller should retry
      }
      const entry: CacheEntry<T> = { value, version: currentVersion + 1 };
      this.data.set(key, entry);
      return entry;
    } finally {
      release();
    }
  }

  /**
   * Atomic read-modify-write.  The `updater` function receives the
   * current value (or `undefined` for a new key) and returns the new
   * value.  The entire operation runs under the key lock so no
   * interleaving is possible.
   */
  async update(
    key: string,
    updater: (current: T | undefined) => T
  ): Promise<CacheEntry<T>> {
    const release = await this.keyLock.acquire(key);
    try {
      const existing = this.data.get(key);
      const newValue = updater(existing?.value);
      const version = (existing?.version ?? 0) + 1;
      const entry: CacheEntry<T> = { value: newValue, version };
      this.data.set(key, entry);
      return entry;
    } finally {
      release();
    }
  }

  /** Remove a key (also locked to avoid races with concurrent updates). */
  async delete(key: string): Promise<boolean> {
    const release = await this.keyLock.acquire(key);
    try {
      return this.data.delete(key);
    } finally {
      release();
    }
  }

  /** Invalidate (alias for delete) — explicitly named for cache semantics. */
  async invalidate(key: string): Promise<boolean> {
    return this.delete(key);
  }

  /** Number of entries in the cache. */
  get size(): number {
    return this.data.size;
  }

  /** Remove all entries. */
  clear(): void {
    this.data.clear();
  }
}
