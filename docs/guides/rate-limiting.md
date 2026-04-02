---
title: "Rate Limiting Guide"
---

# Rate Limiting Guide

API rate limits: 1000 requests per minute per API key. Exceeded requests return 429 with Retry-After header.

## Rate Limiting Middleware

The `rateLimit` middleware uses a **sliding window algorithm** to enforce
request limits per client. Unlike a fixed-window counter, it prevents burst
allowance at window boundaries.

### Quick Start

```typescript
import { rateLimit } from './src/middleware/rate-limit.js';

// Apply globally
app.use(rateLimit({
  windowMs: 60_000,     // 1-minute window
  maxRequests: 100,     // max 100 requests per window
}));

// Apply per-route
app.use('/api', rateLimit({
  windowMs: 60_000,
  maxRequests: 100,
  keyGenerator: (req) => req.ip,
}));
```

### Configuration Options

| Option         | Type       | Default        | Description                                         |
|----------------|------------|----------------|-----------------------------------------------------|
| `windowMs`     | `number`   | *(required)*   | Sliding window duration in milliseconds. Must be > 0. |
| `maxRequests`  | `number`   | *(required)*   | Maximum requests allowed per window. Must be ≥ 1.    |
| `keyGenerator` | `function` | `req => req.ip`| Returns a string key identifying the client.         |
| `store`        | `object`   | `MemoryStore`  | Pluggable store (must implement `get`/`set`/`clear`).|

### Response When Limited

When a client exceeds the limit, the middleware responds with:

- **Status**: `429 Too Many Requests`
- **Header**: `Retry-After: <seconds>` — seconds until the client can retry
- **Body**: `{ "error": "Too Many Requests", "retryAfter": <seconds> }`

### Custom Key Generator

Rate-limit by user ID instead of IP:

```typescript
app.use('/api', rateLimit({
  windowMs: 60_000,
  maxRequests: 50,
  keyGenerator: (req) => req.userId ?? req.ip,
}));
```

### Custom Store

The default `MemoryStore` is suitable for single-process deployments.
For multi-instance setups, implement the `RateLimitStore` interface
with a shared backing store (e.g., Redis):

```typescript
import type { RateLimitStore } from './src/middleware/rate-limit.js';

const redisStore: RateLimitStore = {
  get(key: string): number[]   { /* fetch from Redis */ },
  set(key: string, ts: number[]): void { /* write to Redis */ },
  clear(): void                { /* flush */ },
};

app.use(rateLimit({ windowMs: 60_000, maxRequests: 100, store: redisStore }));
```

### How the Sliding Window Works

1. Each request records a timestamp for the client's key.
2. On the next request, timestamps older than `now - windowMs` are pruned.
3. If the remaining count ≥ `maxRequests`, the request is rejected.
4. This avoids the "double burst" problem of fixed-window counters.
