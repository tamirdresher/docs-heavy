/**
 * Authentication routes.
 *
 * Endpoints for user authentication and token management.
 */

import type { RouteDefinition } from '../openapi/types.js';

/**
 * @openapi
 * @summary Register a new user
 * @description Create a new user account.
 * @body { RegisterRequest } - Registration data
 * @response 201 { AuthResponse } - Account created with tokens
 * @response 400 { Error } - Validation error
 * @response 409 { Error } - Email already exists
 */
export const register: RouteDefinition = {
  method: 'post',
  path: '/api/auth/register',
  operationId: 'register',
  tags: ['Auth'],
};

/**
 * @openapi
 * @summary Login
 * @description Authenticate with email and password.
 * @body { LoginRequest } - Login credentials
 * @response 200 { AuthResponse } - Authentication tokens
 * @response 401 { Error } - Invalid credentials
 */
export const login: RouteDefinition = {
  method: 'post',
  path: '/api/auth/login',
  operationId: 'login',
  tags: ['Auth'],
};

/**
 * @openapi
 * @summary Refresh token
 * @description Exchange a refresh token for new access and refresh tokens.
 * @body { RefreshTokenRequest } - Refresh token
 * @response 200 { AuthResponse } - New authentication tokens
 * @response 401 { Error } - Invalid or expired refresh token
 */
export const refreshToken: RouteDefinition = {
  method: 'post',
  path: '/api/auth/refresh',
  operationId: 'refreshToken',
  tags: ['Auth'],
};

/**
 * @openapi
 * @summary Logout
 * @description Invalidate the current session.
 * @response 204 - Logged out successfully
 * @response 401 { Error } - Not authenticated
 */
export const logout: RouteDefinition = {
  method: 'post',
  path: '/api/auth/logout',
  operationId: 'logout',
  tags: ['Auth'],
};
