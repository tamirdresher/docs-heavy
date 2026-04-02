/**
 * Rate-limiting middleware using a sliding window algorithm.
 *
 * Tracks request timestamps per key (default: client IP) and enforces
 * a maximum number of requests within a configurable time window.
 * Unlike a fixed-window counter, the sliding window prevents burst
 * allowance at window boundaries.
 *
 * Usage:
 * ```ts
 * app.use('/api', rateLimit({
 *   windowMs: 60_000,     // 1 minute
 *   maxRequests: 100,
 *   keyGenerator: (req) => req.ip,
 * }));
 * ```
 */

export interface RateLimitOptions {
  /** Duration of the sliding window in milliseconds. Must be > 0. */
  windowMs: number;
  /** Maximum number of requests allowed within the window. Must be ≥ 1. */
  maxRequests: number;
  /** Function that returns a string key identifying the client. Defaults to `req.ip`. */
  keyGenerator?: (req: RateLimitRequest) => string;
  /** Optional external store. Defaults to an in-memory Map. */
  store?: RateLimitStore;
}

/** Minimal request shape the middleware depends on. */
export interface RateLimitRequest {
  ip: string;
  [key: string]: unknown;
}

/** Minimal response shape the middleware depends on. */
export interface RateLimitResponse {
  status(code: number): RateLimitResponse;
  set(header: string, value: string): RateLimitResponse;
  json(body: unknown): void;
}

/** Pluggable store interface for request timestamps. */
export interface RateLimitStore {
  /** Return all recorded timestamps for `key`. */
  get(key: string): number[];
  /** Replace stored timestamps for `key`. */
  set(key: string, timestamps: number[]): void;
  /** Remove all entries (useful for testing). */
  clear(): void;
}

type NextFunction = () => void;

/** Default in-memory store backed by a Map. */
export class MemoryStore implements RateLimitStore {
  private data = new Map<string, number[]>();

  get(key: string): number[] {
    return this.data.get(key) ?? [];
  }

  set(key: string, timestamps: number[]): void {
    this.data.set(key, timestamps);
  }

  clear(): void {
    this.data.clear();
  }
}

/**
 * Validate rate-limit configuration and throw on invalid params.
 */
function validateOptions(opts: RateLimitOptions): void {
  if (typeof opts.windowMs !== 'number' || opts.windowMs <= 0 || !Number.isFinite(opts.windowMs)) {
    throw new Error('windowMs must be a positive finite number');
  }
  if (typeof opts.maxRequests !== 'number' || opts.maxRequests < 1 || !Number.isInteger(opts.maxRequests)) {
    throw new Error('maxRequests must be a positive integer');
  }
  if (opts.keyGenerator !== undefined && typeof opts.keyGenerator !== 'function') {
    throw new Error('keyGenerator must be a function');
  }
  if (opts.store !== undefined && (typeof opts.store.get !== 'function' || typeof opts.store.set !== 'function')) {
    throw new Error('store must implement get(key) and set(key, timestamps) methods');
  }
}

/**
 * Create a rate-limiting middleware function.
 *
 * The sliding window algorithm keeps an array of timestamps per key.
 * On each request the array is pruned to only include timestamps within
 * `[now - windowMs, now]`.  If the pruned length is already at
 * `maxRequests`, the request is rejected with 429.
 */
export function rateLimit(options: RateLimitOptions) {
  validateOptions(options);

  const {
    windowMs,
    maxRequests,
    keyGenerator = (req: RateLimitRequest) => req.ip,
    store = new MemoryStore(),
  } = options;

  return function rateLimitMiddleware(
    req: RateLimitRequest,
    res: RateLimitResponse,
    next: NextFunction,
  ): void {
    const key = keyGenerator(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    // Sliding window: keep only timestamps inside the current window
    const timestamps = store.get(key).filter((t) => t > windowStart);

    if (timestamps.length >= maxRequests) {
      // Compute Retry-After: seconds until the oldest tracked request
      // falls outside the window.
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow + windowMs - now;
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);

      res
        .status(429)
        .set('Retry-After', String(retryAfterSec))
        .json({ error: 'Too Many Requests', retryAfter: retryAfterSec });
      return;
    }

    timestamps.push(now);
    store.set(key, timestamps);
    next();
  };
}
