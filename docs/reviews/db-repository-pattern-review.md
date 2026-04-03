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

## Decision

**Approve with suggestions** — The repository pattern is correctly applied, all three performance optimizations are preserved, and the migration path via the adapter is reasonable. Address the adapter migration timeline in a follow-up.
