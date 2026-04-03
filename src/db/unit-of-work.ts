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
   */
  async begin(): Promise<void> {
    if (this.connection) {
      throw new Error('UnitOfWork already started');
    }
    this.connection = await this.pool.acquire();
    await this.connection.beginTransaction();
  }

  /**
   * Get or create a repository bound to this transaction's connection.
   *
   * @param factory - A function that creates the repository given a connection.
   */
  getRepository<T>(factory: RepositoryFactory<T>): T {
    if (!this.connection) {
      throw new Error('UnitOfWork not started — call begin() first');
    }
    return factory(this.connection);
  }

  /**
   * Get the underlying connection (for repositories that need direct access).
   */
  getConnection(): DatabaseConnection {
    if (!this.connection) {
      throw new Error('UnitOfWork not started — call begin() first');
    }
    return this.connection;
  }

  /**
   * Commit the transaction.
   */
  async commit(): Promise<void> {
    if (!this.connection) throw new Error('UnitOfWork not started');
    if (this.committed) throw new Error('Already committed');
    if (this.rolledBack) throw new Error('Already rolled back');

    try {
      await this.connection.commit();
      this.committed = true;
    } finally {
      this.connection.release();
    }
  }

  /**
   * Rollback the transaction.
   */
  async rollback(): Promise<void> {
    if (!this.connection) throw new Error('UnitOfWork not started');
    if (this.committed) throw new Error('Already committed');
    if (this.rolledBack) return; // Idempotent rollback

    try {
      await this.connection.rollback();
      this.rolledBack = true;
    } finally {
      this.connection.release();
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
    await uow.rollback();
    throw err;
  }
}
