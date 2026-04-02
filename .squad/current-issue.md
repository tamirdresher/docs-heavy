# Race condition in cache invalidation

## Bug Report

**Describe the bug**
Intermittently, the API returns stale data after a PUT request. The issue appears under concurrent load when multiple clients update the same resource simultaneously.

**To reproduce**
1. Start the server
2. Run concurrent PUT requests to `/api/products/123` from 10 clients
3. Immediately GET `/api/products/123`
4. ~15% of the time, the GET returns the old value

**Expected behavior**
After a successful PUT, subsequent GETs should always return the updated value.

**Root cause hypothesis**
The cache layer (`src/cache/store.ts`) does a read-then-write pattern without locking:
```typescript
const current = await cache.get(key);  // Thread A reads
// ... Thread B writes + invalidates here ...
await cache.set(key, updated);         // Thread A writes stale data back
```

**Impact**
Production users see incorrect product prices ~15% of the time under load.