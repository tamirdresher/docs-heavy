/**
 * Authentication middleware.
 *
 * Extracts a JWT bearer token from the Authorization header,
 * verifies it, and attaches the decoded payload to the request
 * for downstream handlers.
 *
 * Protected routes should use this middleware before any
 * business-logic handlers.
 *
 * Usage:
 * ```ts
 * app.get('/api/users/me', authMiddleware(jwtManager), handler);
 * ```
 */

import type { JwtPayload } from '../auth/jwt.js';

export interface AuthRequest {
  headers: Record<string, string | undefined>;
  user?: JwtPayload;
  /** Raw Bearer token string, set by auth middleware for downstream use (e.g. logout blacklisting). */
  token?: string;
  [key: string]: unknown;
}

export interface AuthResponse {
  status(code: number): AuthResponse;
  json(body: unknown): void;
}

type NextFunction = () => void;

export interface JwtVerifier {
  verify(token: string): Promise<JwtPayload | null>;
}

export interface TokenBlacklistChecker {
  has(token: string): boolean;
}

/**
 * Create authentication middleware that validates JWT bearer tokens.
 *
 * Responds with 401 if:
 *  - Authorization header is missing
 *  - Token format is invalid
 *  - Token is expired or has an invalid signature
 *  - Token is not an access token (type !== 'access')
 *  - Token has been blacklisted (e.g. after logout)
 */
export function authMiddleware(jwtManager: JwtVerifier, blacklist?: TokenBlacklistChecker) {
  return async function authenticate(
    req: AuthRequest,
    res: AuthResponse,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers['authorization'] ?? req.headers['Authorization'];

    if (!authHeader) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing authorization header' } });
      return;
    }

    // Expect "Bearer <token>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid authorization format. Expected: Bearer <token>' } });
      return;
    }

    const token = parts[1];

    // Reject blacklisted tokens (logged-out sessions)
    if (blacklist?.has(token)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Token has been revoked' } });
      return;
    }

    const payload = await jwtManager.verify(token);

    if (!payload) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      return;
    }

    // Only accept access tokens (not refresh tokens)
    if (payload.type !== 'access') {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      return;
    }

    req.user = payload;
    req.token = token;
    next();
  };
}
