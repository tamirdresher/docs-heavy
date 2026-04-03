/**
 * User model.
 *
 * In-memory user store for demonstration. In production this would
 * be backed by a database (PostgreSQL, MongoDB, etc.).
 *
 * The password field stores a scrypt hash — never plaintext.
 */

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
 * In-memory user store.
 */
export class UserStore {
  private users = new Map<string, User>();
  private emailIndex = new Map<string, string>(); // email → id

  /**
   * Create a new user. Throws if email is already taken.
   */
  create(data: { email: string; passwordHash: string; role?: 'admin' | 'user' }): User {
    const normalizedEmail = data.email.toLowerCase().trim();

    if (this.emailIndex.has(normalizedEmail)) {
      throw new Error('EMAIL_EXISTS');
    }

    const id = this.generateId();
    const now = new Date().toISOString();
    const user: User = {
      id,
      email: normalizedEmail,
      passwordHash: data.passwordHash,
      role: data.role ?? 'user',
      createdAt: now,
      updatedAt: now,
    };

    this.users.set(id, user);
    this.emailIndex.set(normalizedEmail, id);
    return user;
  }

  /**
   * Find a user by ID.
   */
  findById(id: string): User | undefined {
    return this.users.get(id);
  }

  /**
   * Find a user by email.
   */
  findByEmail(email: string): User | undefined {
    const normalizedEmail = email.toLowerCase().trim();
    const id = this.emailIndex.get(normalizedEmail);
    if (!id) return undefined;
    return this.users.get(id);
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

  private generateId(): string {
    return crypto.randomUUID();
  }
}
