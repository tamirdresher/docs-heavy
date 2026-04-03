/**
 * Database layer — public API.
 *
 * Re-exports connection pool, repository base, and unit of work.
 */

export { ConnectionPool, type PoolOptions, type DatabaseConnection } from './connection-pool.js';
export { Repository, type Entity, type PaginationOptions, type PaginatedResult } from './repository.js';
export { UnitOfWork, withTransaction, type RepositoryFactory } from './unit-of-work.js';
