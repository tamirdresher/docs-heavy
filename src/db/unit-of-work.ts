/**
 * Unit of Work pattern for transactional consistency.
 *
 * Coordinates multiple repository operations within a single
 * database transaction. If any operation fails, all changes
 * are rolled back.
 *
 * Usage:
 *   const uow = new UnitOfWork(pool);
 *   try {
 *     await uow.begin();
 *     const userRepo = uow.getRepository(UserRepository);
 *     await userRepo.create(user);
 *     await uow.commit();
 *   } catch (err) {
 *     await uow.rollback();
 *     throw err;
 *   }
 */

import type { ConnectionPool, DatabaseConnection } from './connection-pool.js';

export type RepositoryFactory<T> = (conn: DatabaseConnection) => T;

/**
 * Unit of Work — wraps multiple operations in a single transaction.
 */
export class UnitOfWork {
  private readonly pool: ConnectionPool;
  private connection: DatabaseConnection | null = null;
  private committed = false;
  private rolledBack = false;

  constructor(pool: ConnectionPool) {
    this.pool = pool;
  }

  /**
   * Begin the transaction.
   * If beginTransaction() fails, the acquired connection is released
   * to prevent pool leaks.
   */
  async begin(): Promise<void> {
    if (this.connection) {
      throw new Error('UnitOfWork already started');
    }
    const conn = await this.pool.acquire();
    try {
      await conn.beginTransaction();
      this.connection = conn;
    } catch (err) {
      conn.release();
      throw err;
    }
  }

  /**
   * Get or create a repository bound to this transaction's connection.
   *
   * @param factory - A function that creates the repository given a connection.
   */
  getRepository<T>(factory: RepositoryFactory<T>): T {
    if (this.committed || this.rolledBack) {
      throw new Error('UnitOfWork already completed — connection has been released');
    }
    if (!this.connection) {
      throw new Error('UnitOfWork not started — call begin() first');
    }
    return factory(this.connection);
  }

  /**
   * Get the underlying connection (for repositories that need direct access).
   */
  getConnection(): DatabaseConnection {
    if (this.committed || this.rolledBack) {
      throw new Error('UnitOfWork already completed — connection has been released');
    }
    if (!this.connection) {
      throw new Error('UnitOfWork not started — call begin() first');
    }
    return this.connection;
  }

  /**
   * Commit the transaction.
   *
   * If the underlying commit() throws (e.g., network error in a real
   * driver), the UoW is marked as rolled-back and the connection is
   * released. This prevents the UoW from appearing "active" with a
   * released connection — a state that would let callers issue queries
   * on a connection that may already be reused by another consumer.
   */
  async commit(): Promise<void> {
    if (!this.connection) throw new Error('UnitOfWork not started');
    if (this.committed) throw new Error('Already committed');
    if (this.rolledBack) throw new Error('Already rolled back');

    try {
      await this.connection.commit();
      this.committed = true;
    } catch (err) {
      // Commit failed — mark as rolled back so isActive returns false
      this.rolledBack = true;
      throw err;
    } finally {
      this.connection.release();
      this.connection = null;
    }
  }

  /**
   * Rollback the transaction.
   *
   * Always marks the UoW as rolled-back and releases the connection,
   * even if the underlying rollback() call throws (e.g., connection
   * already closed). This ensures the UoW never appears "active"
   * after a rollback attempt.
   */
  async rollback(): Promise<void> {
    if (this.rolledBack) return; // Idempotent rollback
    if (this.committed) throw new Error('Already committed');
    if (!this.connection) throw new Error('UnitOfWork not started');

    try {
      await this.connection.rollback();
    } finally {
      this.rolledBack = true;
      this.connection.release();
      this.connection = null;
    }
  }

  /** Whether the transaction has been committed. */
  get isCommitted(): boolean {
    return this.committed;
  }

  /** Whether the transaction has been rolled back. */
  get isRolledBack(): boolean {
    return this.rolledBack;
  }

  /** Whether the unit of work is active (started but not finished). */
  get isActive(): boolean {
    return this.connection !== null && !this.committed && !this.rolledBack;
  }
}

/**
 * Helper: run a callback within a Unit of Work transaction.
 * Automatically commits on success, rolls back on error.
 * If rollback itself fails, the original error is preserved.
 */
export async function withTransaction<R>(
  pool: ConnectionPool,
  fn: (uow: UnitOfWork) => Promise<R>,
): Promise<R> {
  const uow = new UnitOfWork(pool);
  await uow.begin();

  try {
    const result = await fn(uow);
    await uow.commit();
    return result;
  } catch (err) {
    try {
      await uow.rollback();
    } catch {
      // Rollback failure is secondary — always propagate original error
    }
    throw err;
  }
}
