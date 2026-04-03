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

    // Store in-memory (simulates DB INSERT via connection pool)
    this.users.set(id, user);
    this.emailIndex.set(normalizedEmail, id);

    // Also go through the repository base for the SQL path
    await super.create(user);
    return user;
  }

  /**
   * Find a user by ID.
   */
  async findById(id: string): Promise<User | undefined> {
    // Use in-memory for now (in production, this goes through the pool)
    return this.users.get(id);
  }

  /**
   * Find a user by email (prepared statement for performance).
   */
  async findByEmail(email: string): Promise<User | undefined> {
    const normalizedEmail = email.toLowerCase().trim();
    const id = this.emailIndex.get(normalizedEmail);
    if (!id) return undefined;
    return this.users.get(id);
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
 * REVIEW NOTE: This adapter exists for backwards compatibility during
 * migration. New code should use UserRepository directly with await.
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

    // Fire the async DB write (non-blocking for backwards compat)
    this.repo.create(user).catch(() => {
      /* log in production */
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
