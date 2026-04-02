/**
 * User routes.
 *
 * Endpoints for managing user profiles.
 */

import type { RouteDefinition } from '../openapi/types.js';

/**
 * @openapi
 * @summary Get current user
 * @description Retrieve the profile of the currently authenticated user.
 * @response 200 { User } - The current user's profile
 * @response 401 { Error } - Not authenticated
 */
export const getCurrentUser: RouteDefinition = {
  method: 'get',
  path: '/api/users/me',
  operationId: 'getCurrentUser',
  tags: ['Users'],
};

/**
 * @openapi
 * @summary Update current user profile
 * @description Update the profile of the currently authenticated user.
 * @body { UpdateUserRequest } - Updated profile data
 * @response 200 { User } - The updated profile
 * @response 401 { Error } - Not authenticated
 */
export const updateCurrentUser: RouteDefinition = {
  method: 'put',
  path: '/api/users/me',
  operationId: 'updateCurrentUser',
  tags: ['Users'],
};

/**
 * @openapi
 * @summary Get user by ID (admin)
 * @description Retrieve a user by their ID. Requires admin privileges.
 * @param {string} id - User ID (path)
 * @response 200 { User } - The requested user
 * @response 403 { Error } - Forbidden
 * @response 404 { Error } - User not found
 */
export const getUserById: RouteDefinition = {
  method: 'get',
  path: '/api/users/:id',
  operationId: 'getUserById',
  tags: ['Users'],
};
