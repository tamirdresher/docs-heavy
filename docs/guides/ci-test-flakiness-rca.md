---
title: "CI Test Flakiness — Root Cause Analysis"
---

# CI Test Flakiness — Root Cause Analysis

This document investigates non-deterministic test failures observed in CI. Tests pass 100% of the time locally but fail approximately 20% of CI runs.

## Environment Differences

| Factor | Local | CI |
|--------|-------|----|
| Test concurrency | Serial (1 worker) | Parallel (4 workers) |
| Infrastructure | Dedicated containers | Shared Docker containers |
| Database state | Clean per run | Shared across workers |
| Redis instance | Dedicated | Shared across workers |

## Failure Categories

### 1. Timeout on concurrent registration tests (`UserService.test.ts`)

**Symptom:** Test "should handle concurrent registrations" times out intermittently.

**Root cause:** When multiple test workers execute user registration concurrently against a shared database, they contend for unique-constraint locks on email/username columns. Worker A inserts a user, Worker B tries to insert the same seeded user, triggering a constraint violation that the application retries — but the retry loop exceeds the test timeout.

Additionally, the test itself may be spawning concurrent requests that compete with requests from other workers for the same database connection pool, leading to connection starvation under CI's constrained resources.

### 2. Unexpected 500 on order creation (`OrderController.test.ts`)

**Symptom:** "expected 201, received 500" when creating an order.

**Root cause:** Order creation requires a valid user ID and product IDs as foreign keys. When tests run in parallel, Worker A's setup may not have completed before Worker B's order test references those rows — or Worker C's teardown may have already deleted them. The 500 is an unhandled foreign-key violation thrown by the database, which the error handler surfaces as an internal server error rather than a 400.

### 3. Redis connection refused (`CacheService.test.ts`)

**Symptom:** "Redis connection refused" during cache tests.

**Root cause (probable — verify with Redis logs and `CLIENT LIST` counts):** Two contributing factors:

1. **Connection pool exhaustion.** The shared Redis Docker container has a default `maxclients` limit. With 4 parallel workers each opening their own connection pool (typically 5–10 connections), the container may hit its ceiling. Previous test runs that don't cleanly close connections leave stale connections consuming slots until TCP timeout, compounding the issue.

2. **Cache layer race condition.** The cache layer uses a read-then-write pattern without atomic operations. Under parallel workers, concurrent reads can return stale values, and concurrent writes can overwrite each other — potentially corrupting shared cache state or triggering unexpected errors. This is a known risk area per the project's architecture notes.

Note: per-worker Redis *logical* databases (SELECT 0–15) share the same Redis process and the same `maxclients` limit. Logical database isolation prevents key collisions but does **not** fix connection exhaustion.

### 4. Socket hang up (`WebSocketHandler.test.ts`)

**Symptom:** "socket hang up" during WebSocket tests.

**Root cause:** Two contributing factors:

1. **Port conflicts.** WebSocket tests bind to a specific port (e.g., 3001). When multiple workers attempt to start a WebSocket server on the same port, only the first succeeds. Subsequent workers either fail to bind (EADDRINUSE) or connect to a server owned by a different worker that tears down mid-test. The "socket hang up" occurs when the owning worker's afterEach/afterAll closes the server while another worker's client is still connected.

2. **Missing listener cleanup on disconnect.** The WebSocket handler accumulates event listeners without removing them on disconnect — a known issue in the codebase. When a test tears down and reconnects (or another worker's client connects), stale listeners from previous connections remain active, leading to resource leaks, unexpected callbacks, and socket state corruption that manifests as "socket hang up."

## Common Underlying Cause

**All four failure categories stem from two related root causes: shared mutable infrastructure without test isolation, and missing lifecycle cleanup in concurrency-sensitive code paths.**

The CI pipeline runs 4 parallel test workers against shared Docker containers (PostgreSQL, Redis) and shared network ports. Tests assume they have exclusive access to:

1. **Database state** — seed data, foreign key targets, unique constraints
2. **Redis connections and keyspace** — connection pool slots, cached keys
3. **Network ports** — server bind addresses for WebSocket/HTTP test servers

Locally, serial execution provides implicit isolation — each test has exclusive access. In CI, parallelism breaks this assumption.

Additionally, application-level issues — the cache layer's non-atomic read-then-write pattern and the WebSocket handler's missing listener cleanup on disconnect — are latent bugs that only manifest under the concurrent access patterns created by parallel CI workers.

> **Note:** Runs #142 and #131 are the same failure category (UserService timeout) recurring across different CI runs, confirming non-determinism rather than two distinct bugs.

```
Local (serial):     [Worker 1: Test A] → [Worker 1: Test B] → [Worker 1: Test C]
                    ✅ Implicit isolation via ordering

CI (parallel):      [Worker 1: Test A]
                    [Worker 2: Test B]    ← shared DB/Redis/ports
                    [Worker 3: Test C]
                    [Worker 4: Test D]
                    ❌ No isolation, race conditions
```

## Recommended Fix

### Strategy: Per-Worker Isolation

Provide each test worker with its own isolated infrastructure context so parallel execution cannot cause cross-worker interference.

### Implementation Plan

#### Phase 1: Database Isolation (fixes #1 and #2)

1. **Create per-worker databases.** In the CI test setup script, create a separate PostgreSQL database for each worker:

   ```bash
   # ci-test-setup.sh — uses 1-based IDs to match JEST_WORKER_ID
   for i in $(seq 1 $NUM_WORKERS); do
     createdb "testdb_worker_${i}"
     psql "testdb_worker_${i}" < schema.sql
   done
   ```

2. **Inject worker-specific connection strings.** Configure the test runner to pass a `WORKER_ID` environment variable and construct the database URL from it:

   ```typescript
   // test/setup.ts
   const workerId = process.env.JEST_WORKER_ID || '1';
   process.env.DATABASE_URL = `postgres://test:test@localhost:5432/testdb_worker_${workerId}`;
   ```

3. **Seed data per-worker.** Each worker seeds its own database in `beforeAll`, so there are no shared-state conflicts.

#### Phase 2: Redis Isolation (fixes #3)

1. **Increase `maxclients`.** Per-worker logical databases share the same Redis process and connection limit. In the Docker Compose config for CI, set `maxclients` to at least `NUM_WORKERS * POOL_SIZE + 10`:

   ```yaml
   redis:
     image: redis:7
     command: redis-server --maxclients 100
   ```

2. **Use per-worker Redis databases for key isolation.** Assign each worker its own database number to prevent key collisions (note: this does not reduce connection pressure):

   ```typescript
   // test/setup.ts
   const workerId = process.env.JEST_WORKER_ID || '1';
   const redisDb = parseInt(workerId, 10);
   process.env.REDIS_URL = `redis://localhost:6379/${redisDb}`;
   ```

3. **Flush per-worker database in setup.** Call `FLUSHDB` in `beforeAll` for each worker's Redis database to ensure a clean state.

4. **Ensure connection cleanup.** Close all Redis connections in `afterAll` to prevent stale connections from consuming slots across runs.

5. **Fix cache race condition.** Replace the read-then-write cache pattern with atomic operations (e.g., Redis `SET NX`, Lua scripts, or optimistic locking) to prevent concurrent workers from corrupting shared cache state.

#### Phase 3: Port and WebSocket Isolation (fixes #4)

1. **Use dynamic port allocation.** Instead of hardcoded ports, bind test servers to port `0` (OS-assigned) and read back the actual port:

   ```typescript
   const server = app.listen(0, () => {
     const port = (server.address() as AddressInfo).port;
     // pass `port` to test client
   });
   ```

2. **Pass ports through test context.** Share the dynamically assigned port with test cases via a test-scoped fixture or global setup.

3. **Fix WebSocket listener cleanup.** Remove all event listeners on disconnect to prevent listener accumulation across test reconnections:

   ```typescript
   // In WebSocket handler
   ws.on('close', () => {
     ws.removeAllListeners();
   });
   ```

4. **Ensure server/socket teardown in tests.** In `afterEach`/`afterAll`, explicitly close WebSocket servers and await completion before proceeding:

   ```typescript
   afterAll(async () => {
     await new Promise<void>((resolve) => wsServer.close(() => resolve()));
   });
   ```

#### Phase 4: CI Pipeline Updates

1. **Update `docker-compose.ci.yml`** to increase Redis `maxclients` and expose additional ports if needed.

2. **Add a `globalSetup` script** that creates per-worker databases before tests run and tears them down after.

3. **Add a test timeout buffer (temporary mitigation).** CI runners are slower than local machines. Increase default test timeout from 5s to 15s for CI as a safety margin — but this masks issues rather than fixing root causes, so treat it as a stopgap until phases 1–3 are complete:

   ```typescript
   // jest.config.ts (or vitest equivalent)
   export default {
     testTimeout: process.env.CI ? 15000 : 5000,
   };
   ```

## Validation Plan

After implementing the fixes, verify with CI-like parallelism:

1. **Reproduce locally.** Run tests with 4 parallel workers to confirm the same failures appear locally.
2. **Apply fixes incrementally.** Implement phases 1–3, re-run with 4 workers after each phase.
3. **Soak test.** Run 50–100 CI-parallel test runs. Success criteria: 0 failures.
4. **Check for leaks.** After tests complete, verify:
   - No open database connections (`SELECT count(*) FROM pg_stat_activity`)
   - No stale Redis connections (`CLIENT LIST`)
   - No open file handles / sockets (use `--detectOpenHandles` in Jest)

### Expected Outcome

| Fix | Failure Category | Impact |
|-----|-----------------|--------|
| Per-worker databases | Timeouts, unexpected 500s | Eliminates DB contention and FK violations |
| Per-worker Redis databases + maxclients | Connection refused | Eliminates key collisions and connection pool exhaustion |
| Atomic cache operations | Connection refused (race-related) | Eliminates cache corruption under concurrency |
| Dynamic port allocation | Socket hang up | Eliminates port conflicts |
| WebSocket listener cleanup | Socket hang up | Eliminates resource leaks and stale callbacks |
| Increased CI timeout | All (temporary mitigation) | Reduces false timeouts on slow CI runners |

After implementing these changes, CI test runs should achieve the same 100% pass rate as local runs, regardless of parallelism level.
