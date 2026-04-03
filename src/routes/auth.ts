/**
 * Authentication route handlers.
 *
 * Provides login, register, refresh, and logout endpoints.
 * Uses JWT tokens for stateless authentication.
 *
 * Endpoints:
 *  - POST /api/auth/register  — Create a new user account
 *  - POST /api/auth/login     — Authenticate with email/password
 *  - POST /api/auth/refresh   — Exchange refresh token for new token pair
 *  - POST /api/auth/logout    — Invalidate session (placeholder)
 */

import { hashPassword, verifyPassword } from '../auth/password.js';
import type { JwtPayload } from '../auth/jwt.js';

export interface AuthRouteRequest {
  body: Record<string, unknown>;
  user?: JwtPayload;
  /** Raw Bearer token string, set by auth middleware. */
  token?: string;
  [key: string]: unknown;
}

export interface AuthRouteResponse {
  status(code: number): AuthRouteResponse;
  json(body: unknown): void;
  end(): void;
}

export interface AuthDependencies {
  userStore: {
    findByEmail(email: string): { id: string; email: string; passwordHash: string; role: 'admin' | 'user' } | undefined;
    findById(id: string): { id: string; email: string; passwordHash: string; role: 'admin' | 'user' } | undefined;
    create(data: { email: string; passwordHash: string; role?: 'admin' | 'user' }): { id: string; email: string; role: 'admin' | 'user' };
    toPublic(user: any): Record<string, unknown>;
  };
  jwtManager: {
    generateTokenPair(userId: string, role: 'admin' | 'user'): Promise<{ accessToken: string; refreshToken: string }>;
    verify(token: string): Promise<JwtPayload | null>;
  };
  tokenBlacklist: {
    add(token: string, expiresAt: number): void;
    has(token: string): boolean;
  };
}

// Email validation: RFC 5321 max length, requires @ and 2+ char TLD
function isValidEmail(email: unknown): email is string {
  if (typeof email !== 'string') return false;
  if (email.length > 254) return false; // RFC 5321 max
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function isValidPassword(password: unknown): password is string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return false;
  // Require at least one uppercase, one lowercase, and one digit
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}

/**
 * Create auth route handlers with injected dependencies.
 */
export function createAuthRoutes(deps: AuthDependencies) {
  const { userStore, jwtManager, tokenBlacklist } = deps;

  /**
   * POST /api/auth/register
   */
  async function register(req: AuthRouteRequest, res: AuthRouteResponse): Promise<void> {
    const { email, password } = req.body;

    if (!isValidEmail(email)) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Valid email is required' },
      });
      return;
    }

    if (!isValidPassword(password)) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters with uppercase, lowercase, and a digit' },
      });
      return;
    }

    // Check for existing user
    const existing = userStore.findByEmail(email);
    if (existing) {
      res.status(409).json({
        error: { code: 'CONFLICT', message: 'An account with this email already exists' },
      });
      return;
    }

    const passwordHash = await hashPassword(password);
    const user = userStore.create({ email, passwordHash });
    const tokens = await jwtManager.generateTokenPair(user.id, user.role);

    res.status(201).json({
      user: userStore.toPublic(user as any),
      ...tokens,
    });
  }

  /**
   * POST /api/auth/login
   */
  async function login(req: AuthRouteRequest, res: AuthRouteResponse): Promise<void> {
    const { email, password } = req.body;

    if (!isValidEmail(email) || typeof password !== 'string') {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Email and password are required' },
      });
      return;
    }

    const user = userStore.findByEmail(email);

    // Always run password verification to prevent timing-based user enumeration.
    // When the user doesn't exist we verify against a dummy hash so the
    // response time is indistinguishable from a real (but wrong) password.
    const DUMMY_HASH = '$scrypt$N=16384$r=8$p=1$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !valid) {
      res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
      return;
    }

    const tokens = await jwtManager.generateTokenPair(user.id, user.role);
    res.status(200).json({
      user: userStore.toPublic(user as any),
      ...tokens,
    });
  }

  /**
   * POST /api/auth/refresh
   *
   * Implements refresh token rotation: the old refresh token is
   * blacklisted after issuing new tokens. A stolen refresh token
   * can only be used once.
   */
  async function refresh(req: AuthRouteRequest, res: AuthRouteResponse): Promise<void> {
    const { refreshToken } = req.body;

    if (typeof refreshToken !== 'string') {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'refreshToken is required' },
      });
      return;
    }

    // Reject blacklisted tokens (already rotated)
    if (tokenBlacklist.has(refreshToken)) {
      res.status(401).json({
        error: { code: 'INVALID_TOKEN', message: 'Refresh token has already been used' },
      });
      return;
    }

    const payload = await jwtManager.verify(refreshToken);
    if (!payload || payload.type !== 'refresh') {
      res.status(401).json({
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired refresh token' },
      });
      return;
    }

    // Verify the user still exists and hasn't been deleted/suspended
    const user = userStore.findById(payload.sub);
    if (!user) {
      res.status(401).json({
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired refresh token' },
      });
      return;
    }

    // Blacklist the old refresh token (rotation)
    tokenBlacklist.add(refreshToken, payload.exp);

    // Use the user's current role (may have changed since the token was issued)
    const tokens = await jwtManager.generateTokenPair(user.id, user.role);
    res.status(200).json(tokens);
  }

  /**
   * POST /api/auth/logout
   *
   * Blacklists the access token so it can no longer be used,
   * even before its natural expiration. Requires the raw token
   * to be set on the request by auth middleware (req.token).
   */
  function logout(req: AuthRouteRequest, res: AuthRouteResponse): void {
    if (req.user && req.token) {
      tokenBlacklist.add(req.token, req.user.exp);
    }
    res.status(204).end();
  }

  return { register, login, refresh, logout };
}
