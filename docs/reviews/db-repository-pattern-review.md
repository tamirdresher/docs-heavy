---
title: "Code Review: Refactor DB Layer to Repository Pattern"
---

# Code Review: Refactor DB Layer to Repository Pattern

**PR**: #55 — Refactor DB layer to repository pattern
**Reviewer**: Coding Agent
**Date**: 2026-04-03
**Verdict**: Approve with suggestions

## Summary

This PR refactors the data access layer from in-memory stores with inline logic to a structured repository pattern with dependency injection. The changes introduce proper separation of concerns between route handlers and data access.

## Architecture Review

### Repository Pattern ✅

The `Repository<T>` base class correctly implements:

- **Generic CRUD**: `findById`, `create`, `update`, `delete`, `count`
- **Batch queries**: `findByIds` uses a single `IN` clause instead of N queries
- **Cursor pagination**: `list()` with cursor-based pagination using prepared statements
- **Connection lifecycle**: acquire/release pattern with proper cleanup in `finally` blocks

### Connection Pool ✅

- Configurable `minSize`/`maxSize` with validation
- Idle connection reaping to prevent resource leaks
- Prepared statement caching per connection
- Proper error handling for pool exhaustion

### Unit of Work ✅

- Transaction boundary management (begin/commit/rollback)
- `withTransaction()` helper for auto-commit/rollback
- Idempotent rollback (safe to call multiple times)
- Prevents double-commit and commit-after-rollback

## Performance Optimizations Preserved

| Optimization | Status | Location |
|---|---|---|
| Batch queries | ✅ Preserved | `Repository.findByIds()` — single IN-clause |
| Cursor pagination | ✅ Preserved | `Repository.list()` — cursor + LIMIT |
| Prepared statements | ✅ Preserved | `Connection.execute()` — cached by name |

## Issues Found

### 🟢 Fixed: Connection release auto-rollbacks abandoned transactions

The `release()` method previously silently cleared transaction state without rolling back. In a real database driver, this would leave dangling locks. Now `release()` triggers an async rollback before returning the connection to the pool.

### 🟢 Fixed: UserRepository.createUser() writes DB before in-memory

Previously, in-memory maps were updated before the DB write (`super.create()`). If the DB write failed, in-memory state would diverge from the database. Now the DB write happens first; in-memory indexes are only updated on success.

### 🟢 Fixed: UserRepository.findById() delegates to connection pool

The method was hardcoded to read only from in-memory maps, bypassing the connection pool entirely. Now it checks the in-memory cache first and falls back to the parent `Repository.findById()` which goes through the pool.

### 🟢 Fixed: Connection pool waits on exhaustion instead of failing fast

`acquire()` previously threw immediately when the pool was full. Now it queues the request and waits up to `acquireTimeoutMs` (default 5 s) for a connection to be released, preventing cascading failures from transient traffic spikes.

### 🟢 Fixed: Pool close() drains wait queue

`close()` now rejects all pending acquire waiters with "Pool is closed" before clearing connections, preventing hung promises.

### 🟢 Fixed: Adapter.create() rolls back in-memory on DB failure

The fire-and-forget DB write in `UserRepositoryAdapter.create()` silently swallowed errors. Now it rolls back in-memory state and logs the error if the async DB write fails.

### 🟡 Suggestion: Adapter bypasses async safety

The `UserRepositoryAdapter` provides sync backwards compatibility by accessing internal Maps directly. While necessary for the migration, this creates a dual-write path where the in-memory state and DB state could diverge if the async `create()` fails silently.

**Recommendation**: Set a migration deadline to convert all callers to async `UserRepository` methods, then remove the adapter.

### 🟡 Suggestion: Missing connection timeout

The `acquire()` method throws immediately when the pool is exhausted. Consider adding a configurable wait timeout that queues the request and retries when a connection is released.

### 🟡 Suggestion: No query logging

For production debugging, add optional query logging (SQL + params + duration) at the connection level. This would help trace N+1 regressions.

### ✅ Good: Entity mapping is explicit

The `toEntity`/`toRow` mapping in `UserRepository` correctly handles the `passwordHash` ↔ `password_hash` column naming convention, preventing accidental exposure of internal DB column names.

## Testing

- 35 new tests covering pool, connections, transactions, repository, and adapter
- Tests use real (in-memory) connections, not mocks
- Pagination edge cases tested (empty, single page, multi-page, limit bounds)
- Error paths tested (pool exhaustion, double transactions, commit after rollback)

## Follow-up Review (Round 2)

### 🟢 Added: Query logging for production debugging

Optional `queryLogger` callback on `PoolOptions` logs every `query()` and `execute()` call with SQL, params, duration, and connection ID. Disabled by default — no performance impact when not set. Useful for detecting N+1 regressions and slow queries.

### 🟢 Added: Repository CRUD test coverage

Added tests for `Repository.update()`, `Repository.delete()`, and `Repository.count()` — these base class operations had no direct test coverage.

### 🟢 Added: Adapter deprecation annotations

`UserRepositoryAdapter` now has `@deprecated` JSDoc tags and a TODO with a target removal timeline, making the migration intent explicit for IDE tooling.

### 🟡 Note: Repository.update() acquires two connections sequentially

`update()` calls `this.findById()` (acquires + releases) then acquires a second connection for the UPDATE. This is sequential (not concurrent), so it won't deadlock, but it does use two pool round-trips. A production optimization would combine the existence check and update into a single SQL statement (e.g., `UPDATE ... RETURNING *`). Added a test confirming it works with `maxSize=1`.

## Updated Test Coverage

| Suite | Tests |
|---|---|
| Auth tests | 70 |
| Repository tests | 56 |
| **Total** | **126** |

## Follow-up Review (Round 3)

### 🟢 Fixed: UnitOfWork.begin() leaked connection on beginTransaction failure

If `beginTransaction()` threw after the connection was acquired, the connection was never released back to the pool — a resource leak. Now `begin()` wraps `beginTransaction()` in a try/catch that releases the connection on failure.

### 🟢 Fixed: UserRepository cache invalidation on update/delete

`UserRepository` maintains in-memory caches (`users`, `emailIndex`) for fast lookups. The base `Repository<T>.update()` and `delete()` methods were inherited without cache invalidation, so stale data would be served after mutations. Now both methods are overridden to keep caches in sync.

### 🟢 Fixed: findByEmail() falls back to DB on cache miss

Previously, `findByEmail()` only searched the in-memory `emailIndex`. In multi-instance deployments, users created on other instances were invisible. Now it falls back to a prepared-statement DB query on cache miss and populates the cache on hit.

### 🟢 Fixed: withTransaction() preserves original error when rollback fails

If the user callback threw and then `rollback()` also threw (e.g., connection already released), the rollback error would overwrite the original. Now the rollback error is swallowed and the original error is always rethrown.

### 🟢 Fixed: Double initialize() no longer leaks reaper intervals

Calling `initialize()` twice would start a second `setInterval` reaper without clearing the first, causing duplicate reaping and a resource leak. Now repeated calls are safe no-ops.

### 🟢 Fixed: release() defers pool return when auto-rolling back

Previously, `release()` returned the connection to the pool synchronously even when an auto-rollback was in progress. A waiting consumer could receive a mid-rollback connection. Now the pool return is deferred to the next microtick so the state cleanup completes first.

## Decision

**Approve with suggestions** — The repository pattern is correctly applied, all three performance optimizations are preserved, and the migration path via the adapter is reasonable. Address the adapter migration timeline in a follow-up.
