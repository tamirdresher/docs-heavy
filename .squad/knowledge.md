# Project Knowledge Graph

## Architecture Map
- [[src/routes]] → Express route handlers (API endpoints)
- [[src/cache/store.ts]] → Cache layer with read-then-write pattern
  - **Known issue:** Race condition on concurrent writes without locking
- [[src/ws/handler.ts]] → WebSocket handler
  - **Known issue:** Event listener accumulation causes memory leaks
- [[src/models]] → Database models (ORM-backed)
- [[src/webhooks]] → Webhook delivery system
- [[src/utils]] → Shared utilities

## Learned Patterns

### Memory Management
- **WebSocket handlers MUST remove event listeners on disconnect**
  - Use ws.removeAllListeners() or ws.off('message', handler) in cleanup
  - Pattern: Store handler references to enable proper cleanup
- **Event emitter listener limits:**
  - Node.js warns at 11 listeners for same event (memory leak indicator)
  - Always clean up listeners in disconnect/close handlers

### Concurrency & Race Conditions
- **Cache invalidation requires atomic operations**
  - Read-then-write creates race window
  - Use optimistic locking or single-operation updates
- **ORM version upgrades can introduce N+1 queries**
  - Always benchmark after dependency updates
  - Check query count in test logs

### Input Validation
- **Validation should use middleware, not inline checks**
  - Centralizes validation logic
  - Prevents bypass via alternative routes
- **Watch for:** Null bytes, SQL injection, path traversal in user input

### Retry Logic
- **Exponential backoff pattern:**
  - Base delay * (2 ^ attempt_number)
  - Add jitter to prevent thundering herd (optional in v1)
- **Dead-letter queue for permanent failures**
  - Move messages after max retries exceeded
  - Enable manual inspection and replay

## Common Pitfalls

### Bug Type: Memory Leaks
- **Primary cause:** Event listener accumulation
- **Where to look:** WebSocket handlers, event emitters, interval timers
- **Fix pattern:** Always pair .on() with .off() or .removeAllListeners()

### Bug Type: Cache Race Conditions
- **Primary cause:** Read-then-write without locking
- **Where to look:** Cache store operations with conditional updates
- **Fix pattern:** Use atomic compare-and-swap or optimistic locking

### Feature Type: Webhook Retry
- **Requirements pattern:** Retry count, backoff formula, dead-letter handling
- **Where to implement:** Dedicated webhook service module
- **Test coverage:** Unit tests for backoff calculation, integration tests for delivery flow

## Project-Specific Conventions
- **Test location:** 	ests/ or __tests__/ adjacent to source
- **Error handling:** Use custom error classes extending Error
- **Logging:** Use structured logging (JSON format preferred)
- **Configuration:** Environment variables via .env file (dotenv)
