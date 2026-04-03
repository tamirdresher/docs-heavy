/**
 * Role-based access control middleware.
 *
 * Must be used AFTER the auth middleware, as it relies on `req.user`
 * being populated with a decoded JWT payload.
 *
 * Usage:
 * ```ts
 * app.delete('/api/users/:id',
 *   authMiddleware(jwtManager),
 *   requireRole('admin'),
 *   deleteUserHandler,
 * );
 * ```
 */

import type { AuthRequest, AuthResponse } from './auth.js';

type NextFunction = () => void;

/**
 * Create middleware that restricts access to users with one of the
 * specified roles.
 *
 * Returns 403 Forbidden if the user's role is not in the allowed set.
 * Returns 401 Unauthorized if the user is not authenticated.
 */
export function requireRole(...allowedRoles: Array<'admin' | 'user'>) {
  if (allowedRoles.length === 0) {
    throw new Error('At least one role must be specified');
  }

  return function roleMiddleware(
    req: AuthRequest,
    res: AuthResponse,
    next: NextFunction,
  ): void {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Insufficient permissions',
        },
      });
      return;
    }

    next();
  };
}
