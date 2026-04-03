/**
 * Generic Repository<T> base class.
 *
 * Provides standard CRUD operations backed by the connection pool.
 * Concrete repositories extend this class and add domain-specific
 * query methods.
 *
 * Design decisions:
 *  - Batch queries: findByIds() uses a single IN-clause query
 *    instead of N individual lookups (preserves batch optimization).
 *  - Cursor pagination: list() uses cursor-based pagination with
 *    prepared statements (preserves cursor + prepared-statement opts).
 *  - All queries are parameterized to prevent SQL injection.
 */

import type { ConnectionPool, DatabaseConnection } from './connection-pool.js';

export interface Entity {
  id: string;
}

export interface PaginationOptions {
  /** Cursor: ID of the last item on the previous page. */
  cursor?: string;
  /** Maximum number of items to return. Default: 20. */
  limit?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  /** Cursor for the next page, or null if no more items. */
  nextCursor: string | null;
  /** Whether there are more items after this page. */
  hasMore: boolean;
}

/**
 * Abstract repository providing CRUD + batch + pagination operations.
 *
 * Subclasses must implement:
 *  - tableName: the SQL table name
 *  - toEntity: map a database row to a typed entity
 *  - toRow: map a typed entity to a database row
 */
export abstract class Repository<T extends Entity> {
  protected readonly pool: ConnectionPool;

  constructor(pool: ConnectionPool) {
    this.pool = pool;
  }

  /** SQL table name for this entity. */
  protected abstract get tableName(): string;

  /** Map a raw database row to a typed entity. */
  protected abstract toEntity(row: Record<string, unknown>): T;

  /** Map a typed entity to a database row for INSERT/UPDATE. */
  protected abstract toRow(entity: Partial<T>): Record<string, unknown>;

  /**
   * Find a single entity by ID.
   */
  async findById(id: string): Promise<T | undefined> {
    const conn = await this.pool.acquire();
    try {
      const rows = await conn.execute<Record<string, unknown>>(
        `${this.tableName}_findById`,
        `SELECT * FROM ${this.tableName} WHERE id = $1`,
        [id],
      );
      return rows.length > 0 ? this.toEntity(rows[0]) : undefined;
    } finally {
      conn.release();
    }
  }

  /**
   * Find multiple entities by IDs in a single batch query.
   * Preserves the batch-query performance optimization.
   */
  async findByIds(ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];

    const conn = await this.pool.acquire();
    try {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await conn.query<Record<string, unknown>>(
        `SELECT * FROM ${this.tableName} WHERE id IN (${placeholders})`,
        ids,
      );
      return rows.map((row) => this.toEntity(row));
    } finally {
      conn.release();
    }
  }

  /**
   * List entities with cursor-based pagination.
   * Uses prepared statements for consistent performance.
   */
  async list(options: PaginationOptions = {}): Promise<PaginatedResult<T>> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const conn = await this.pool.acquire();

    try {
      let rows: Record<string, unknown>[];

      if (options.cursor) {
        rows = await conn.execute<Record<string, unknown>>(
          `${this.tableName}_listAfterCursor`,
          `SELECT * FROM ${this.tableName} WHERE id > $1 ORDER BY id ASC LIMIT $2`,
          [options.cursor, limit + 1],
        );
      } else {
        rows = await conn.execute<Record<string, unknown>>(
          `${this.tableName}_listFirst`,
          `SELECT * FROM ${this.tableName} ORDER BY id ASC LIMIT $1`,
          [limit + 1],
        );
      }

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map((row) => this.toEntity(row));
      const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

      return { items, nextCursor, hasMore };
    } finally {
      conn.release();
    }
  }

  /**
   * Create a new entity.
   */
  async create(entity: T): Promise<T> {
    const conn = await this.pool.acquire();
    try {
      const row = this.toRow(entity);
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

      await conn.query(
        `INSERT INTO ${this.tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
        values,
      );
      return entity;
    } finally {
      conn.release();
    }
  }

  /**
   * Update an existing entity.
   */
  async update(id: string, changes: Partial<T>): Promise<T | undefined> {
    const existing = await this.findById(id);
    if (!existing) return undefined;

    const conn = await this.pool.acquire();
    try {
      const row = this.toRow(changes);
      const columns = Object.keys(row);
      const values = Object.values(row);
      const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(', ');

      await conn.query(
        `UPDATE ${this.tableName} SET ${setClause} WHERE id = $${columns.length + 1}`,
        [...values, id],
      );

      return { ...existing, ...changes };
    } finally {
      conn.release();
    }
  }

  /**
   * Delete an entity by ID.
   */
  async delete(id: string): Promise<boolean> {
    const conn = await this.pool.acquire();
    try {
      await conn.execute<Record<string, unknown>>(
        `${this.tableName}_delete`,
        `DELETE FROM ${this.tableName} WHERE id = $1`,
        [id],
      );
      return true;
    } finally {
      conn.release();
    }
  }

  /**
   * Count all entities in the table.
   */
  async count(): Promise<number> {
    const conn = await this.pool.acquire();
    try {
      const rows = await conn.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${this.tableName}`,
      );
      return rows[0]?.count ?? 0;
    } finally {
      conn.release();
    }
  }
}
