# Investigate why tests are flaky in CI

## Investigation Request

**Problem**
The CI pipeline fails ~20% of the time on the test suite. Failures are non-deterministic and don't reproduce locally.

**Observed failures** (from last 10 CI runs):
- Run #142: `UserService.test.ts` — timeout on "should handle concurrent registrations"
- Run #138: `OrderController.test.ts` — "expected 201, received 500" on create order
- Run #135: `CacheService.test.ts` — "Redis connection refused"
- Run #131: `UserService.test.ts` — timeout again (same test)
- Run #128: `WebSocketHandler.test.ts` — "socket hang up"

**Local environment**: Tests pass 100% of the time (100 consecutive runs).

**CI environment**: Ubuntu 22.04, Node 20, Docker containers for Redis/Postgres.

**Clues**
1. Failures cluster around tests that use Redis or database connections
2. CI runs tests in parallel (4 workers) while local runs are serial
3. Docker containers are shared across parallel test workers
4. No test isolation between workers for database state

**Deliverable**
Write a root cause analysis document explaining:
1. Why each failure category occurs
2. The common underlying cause
3. Recommended fix (with implementation plan)