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
  [key: string]: unknown;
}

export interface AuthRouteResponse {
  status(code: number): AuthRouteResponse;
  json(body: unknown): void;
}

export interface AuthDependencies {
  userStore: {
    findByEmail(email: string): { id: string; email: string; passwordHash: string; role: 'admin' | 'user' } | undefined;
    create(data: { email: string; passwordHash: string; role?: 'admin' | 'user' }): { id: string; email: string; role: 'admin' | 'user' };
    toPublic(user: any): Record<string, unknown>;
  };
  jwtManager: {
    generateTokenPair(userId: string, role: 'admin' | 'user'): Promise<{ accessToken: string; refreshToken: string }>;
    verify(token: string): Promise<JwtPayload | null>;
  };
}

// Email validation: basic check for presence and @ symbol
function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= 8;
}

/**
 * Create auth route handlers with injected dependencies.
 */
export function createAuthRoutes(deps: AuthDependencies) {
  const { userStore, jwtManager } = deps;

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
        error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' },
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
    if (!user) {
      // Use generic message to prevent user enumeration
      res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
      return;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
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
   */
  async function refresh(req: AuthRouteRequest, res: AuthRouteResponse): Promise<void> {
    const { refreshToken } = req.body;

    if (typeof refreshToken !== 'string') {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'refreshToken is required' },
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

    const tokens = await jwtManager.generateTokenPair(payload.sub, payload.role);
    res.status(200).json(tokens);
  }

  /**
   * POST /api/auth/logout
   *
   * Note: With stateless JWTs, true logout requires a token
   * blacklist or short TTLs. This is a placeholder.
   */
  function logout(_req: AuthRouteRequest, res: AuthRouteResponse): void {
    res.status(204).json({});
  }

  return { register, login, refresh, logout };
}
