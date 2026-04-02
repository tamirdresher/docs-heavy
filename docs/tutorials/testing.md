---
title: "Testing Your Integration"
---

# Testing Your Integration

Best practices for testing your API integration including mocking and sandbox environments.

## CI Test Isolation

When running tests in parallel (e.g., CI pipelines with multiple workers), ensure each worker has isolated infrastructure:

- **Database:** Use per-worker databases or schemas to prevent shared-state conflicts (unique constraint violations, missing foreign keys from concurrent teardowns).
- **Redis:** Assign each worker a separate Redis database number (0–15) to avoid connection pool exhaustion and key collisions.
- **Ports:** Use dynamic port allocation (`port: 0`) for test servers to prevent `EADDRINUSE` and `socket hang up` errors.
- **Timeouts:** CI runners are slower than local machines. Increase test timeouts (e.g., 15s) when the `CI` environment variable is set.

See the [CI Test Flakiness RCA](/guides/ci-test-flakiness-rca) for a detailed analysis of common parallel test failures and solutions.
