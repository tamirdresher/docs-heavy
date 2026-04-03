/**
 * In-memory token blacklist.
 *
 * Used to invalidate tokens before their natural expiry — e.g. on
 * logout or after refresh-token rotation.
 *
 * Entries are automatically pruned once they expire, so the set does
 * not grow unboundedly.  In production, replace with a Redis set
 * using TTL matching each token's remaining lifetime.
 */

export class TokenBlacklist {
  /** Map from token string → expiry timestamp (seconds since epoch). */
  private entries = new Map<string, number>();

  /** Maximum number of entries before oldest are evicted. */
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  /**
   * Add a token to the blacklist.
   *
   * @param token - The raw JWT string to blacklist.
   * @param expiresAt - The token's `exp` claim (seconds since epoch).
   *   Once this time passes the entry is safe to prune.
   */
  add(token: string, expiresAt: number): void {
    this.entries.set(token, expiresAt);
    this.prune();

    // Evict oldest entries if we exceed maxSize
    if (this.entries.size > this.maxSize) {
      const excess = this.entries.size - this.maxSize;
      const iter = this.entries.keys();
      for (let i = 0; i < excess; i++) {
        const key = iter.next().value;
        if (key !== undefined) this.entries.delete(key);
      }
    }
  }

  /**
   * Check whether a token has been blacklisted.
   */
  has(token: string): boolean {
    this.prune();
    return this.entries.has(token);
  }

  /**
   * Remove all expired entries (their tokens are no longer valid
   * anyway, so there is no need to keep them).
   */
  private prune(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [tok, exp] of this.entries) {
      if (exp <= now) {
        this.entries.delete(tok);
      }
    }
  }

  /** Number of currently tracked entries (for testing). */
  get size(): number {
    return this.entries.size;
  }

  /** Remove all entries (for testing). */
  clear(): void {
    this.entries.clear();
  }
}
