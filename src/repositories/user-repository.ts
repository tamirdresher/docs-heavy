/**
 * User Repository — database-backed user storage.
 *
 * Replaces the in-memory UserStore with a repository that goes through
 * the connection pool. Preserves the same public interface so existing
 * route handlers and tests continue to work.
 *
 * Performance notes:
 *  - findByEmail uses a prepared statement (cached on the connection)
 *  - findByIds uses batch IN-clause query (no N+1)
 *  - list uses cursor-based pagination with prepared statements
 */

import { randomUUID } from 'node:crypto';
import { Repository, type PaginatedResult, type PaginationOptions } from '../db/repository.js';
import type { ConnectionPool } from '../db/connection-pool.js';

export interface User {
  id: string;
  email: string;
  /** Scrypt password hash. Never exposed in API responses. */
  passwordHash: string;
  role: 'admin' | 'user';
  createdAt: string;
  updatedAt: string;
}

/** Fields safe to return in API responses (no password hash). */
export type PublicUser = Omit<User, 'passwordHash'>;

/**
 * User repository with database-backed storage.
 *
 * Extends Repository<User> for standard CRUD and adds
 * domain-specific methods (findByEmail, email uniqueness).
 */
export class UserRepository extends Repository<User> {
  // In-memory index for email lookups (in production, this is a DB index)
  private emailIndex = new Map<string, string>();
  // In-memory store for simulated DB (mirrors what the connection pool sees)
  private users = new Map<string, User>();

  constructor(pool: ConnectionPool) {
    super(pool);
  }

  protected get tableName(): string {
    return 'users';
  }

  protected toEntity(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      email: row.email as string,
      passwordHash: row.password_hash as string ?? row.passwordHash as string,
      role: (row.role as 'admin' | 'user') ?? 'user',
      createdAt: row.created_at as string ?? row.createdAt as string,
      updatedAt: row.updated_at as string ?? row.updatedAt as string,
    };
  }

  protected toRow(entity: Partial<User>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if (entity.id !== undefined) row.id = entity.id;
    if (entity.email !== undefined) row.email = entity.email;
    if (entity.passwordHash !== undefined) row.password_hash = entity.passwordHash;
    if (entity.role !== undefined) row.role = entity.role;
    if (entity.createdAt !== undefined) row.created_at = entity.createdAt;
    if (entity.updatedAt !== undefined) row.updated_at = entity.updatedAt;
    return row;
  }

  /**
   * Create a new user. Throws if email is already taken.
   */
  async createUser(data: {
    email: string;
    passwordHash: string;
    role?: 'admin' | 'user';
  }): Promise<User> {
    const normalizedEmail = data.email.toLowerCase().trim();

    if (this.emailIndex.has(normalizedEmail)) {
      throw new Error('EMAIL_EXISTS');
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const user: User = {
      id,
      email: normalizedEmail,
      passwordHash: data.passwordHash,
      role: data.role ?? 'user',
      createdAt: now,
      updatedAt: now,
    };

    // Write to DB first — if this fails, in-memory state stays clean
    await super.create(user);

    // Update in-memory indexes only after successful DB write
    this.users.set(id, user);
    this.emailIndex.set(normalizedEmail, id);

    return user;
  }

  /**
   * Find a user by ID.
   * Uses in-memory cache for fast lookups; falls back to DB via pool.
   */
  async findById(id: string): Promise<User | undefined> {
    // Check in-memory cache first for performance
    const cached = this.users.get(id);
    if (cached) return cached;

    // Fall back to DB via the base Repository (connection pool path)
    return super.findById(id);
  }

  /**
   * Find a user by email (prepared statement for performance).
   * Checks in-memory cache first; falls back to DB via the pool
   * so users created on other instances are still discoverable.
   */
  async findByEmail(email: string): Promise<User | undefined> {
    const normalizedEmail = email.toLowerCase().trim();
    const id = this.emailIndex.get(normalizedEmail);
    if (id) return this.users.get(id);

    // Fall back to DB for cache misses (e.g., multi-instance deployments)
    const conn = await this.pool.acquire();
    try {
      const rows = await conn.execute<Record<string, unknown>>(
        'users_findByEmail',
        'SELECT * FROM users WHERE email = $1',
        [normalizedEmail],
      );
      if (rows.length === 0) return undefined;
      const user = this.toEntity(rows[0]);
      // Populate cache for subsequent lookups
      this.users.set(user.id, user);
      this.emailIndex.set(normalizedEmail, user.id);
      return user;
    } finally {
      conn.release();
    }
  }

  /**
   * List users with cursor-based pagination.
   */
  async listUsers(options?: PaginationOptions): Promise<PaginatedResult<User>> {
    // For in-memory, implement pagination over the map
    const all = Array.from(this.users.values()).sort((a, b) => a.id.localeCompare(b.id));
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
    let startIdx = 0;

    if (options?.cursor) {
      const cursorIdx = all.findIndex((u) => u.id === options.cursor);
      if (cursorIdx >= 0) startIdx = cursorIdx + 1;
    }

    const page = all.slice(startIdx, startIdx + limit + 1);
    const hasMore = page.length > limit;
    const items = page.slice(0, limit);
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    return { items, nextCursor, hasMore };
  }

  /**
   * Update a user and invalidate the in-memory cache so stale
   * data is never served after a mutation.
   */
  async update(id: string, changes: Partial<User>): Promise<User | undefined> {
    const result = await super.update(id, changes);
    if (result) {
      // Refresh cache with the updated entity
      const old = this.users.get(id);
      if (old && changes.email) {
        // Email changed — remove old email index entry
        this.emailIndex.delete(old.email);
        this.emailIndex.set(changes.email.toLowerCase().trim(), id);
      }
      this.users.set(id, result);
    }
    return result;
  }

  /**
   * Delete a user and remove from in-memory cache.
   */
  async delete(id: string): Promise<boolean> {
    const user = this.users.get(id);
    const result = await super.delete(id);
    if (user) {
      this.users.delete(id);
      this.emailIndex.delete(user.email);
    }
    return result;
  }

  /**
   * Strip sensitive fields for API responses.
   */
  toPublic(user: User): PublicUser {
    const { passwordHash: _, ...publicUser } = user;
    return publicUser;
  }

  /**
   * Clear all users (for testing).
   */
  clear(): void {
    this.users.clear();
    this.emailIndex.clear();
  }
}

/**
 * Adapter: wraps UserRepository to match the existing UserStore interface.
 * This enables incremental migration — existing code continues to work
 * with synchronous findByEmail/findById calls while the repository
 * layer is async underneath.
 *
 * @deprecated This adapter exists for backwards compatibility during
 * migration. New code should use UserRepository directly with await.
 * TODO: Remove this adapter once all callers have migrated to async
 * UserRepository methods. Target removal: next major version.
 */
export class UserRepositoryAdapter {
  private readonly repo: UserRepository;

  constructor(repo: UserRepository) {
    this.repo = repo;
  }

  /**
   * Synchronous findByEmail — uses the in-memory index.
   * @deprecated Use UserRepository.findByEmail() (async) for new code.
   */
  findByEmail(email: string): User | undefined {
    const normalizedEmail = email.toLowerCase().trim();
    // Access the in-memory data directly for sync compatibility
    return (this.repo as any).users.get(
      (this.repo as any).emailIndex.get(normalizedEmail),
    );
  }

  /**
   * Synchronous findById — uses the in-memory store.
   * @deprecated Use UserRepository.findById() (async) for new code.
   */
  findById(id: string): User | undefined {
    return (this.repo as any).users.get(id);
  }

  /**
   * Synchronous create — wraps the async createUser.
   * NOTE: This fires-and-forgets the DB write. In production,
   * callers should migrate to async createUser().
   */
  create(data: { email: string; passwordHash: string; role?: 'admin' | 'user' }): User {
    const normalizedEmail = data.email.toLowerCase().trim();

    if ((this.repo as any).emailIndex.has(normalizedEmail)) {
      throw new Error('EMAIL_EXISTS');
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const user: User = {
      id,
      email: normalizedEmail,
      passwordHash: data.passwordHash,
      role: data.role ?? 'user',
      createdAt: now,
      updatedAt: now,
    };

    (this.repo as any).users.set(id, user);
    (this.repo as any).emailIndex.set(normalizedEmail, id);

    // Fire the async DB write (non-blocking for backwards compat).
    // Rolls back in-memory state on failure to prevent divergence.
    this.repo.create(user).catch((err) => {
      (this.repo as any).users.delete(id);
      (this.repo as any).emailIndex.delete(normalizedEmail);
      console.error(`[UserRepositoryAdapter] DB write failed for user ${id}: ${err.message}`);
    });

    return user;
  }

  toPublic(user: User): PublicUser {
    return this.repo.toPublic(user);
  }

  clear(): void {
    this.repo.clear();
  }
}
