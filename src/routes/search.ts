/**
 * Search routes.
 *
 * Full-text search across products and orders.
 */

import type { RouteDefinition } from '../openapi/types.js';

/**
 * @openapi
 * @summary Full-text search
 * @description Search across products and orders using a query string.
 * @param {string} q - Search query term (query)
 * @param {number} page - Page number (query)
 * @param {number} limit - Items per page (query)
 * @response 200 { SearchResults } - Search results
 * @response 400 { Error } - Missing query parameter
 */
export const search: RouteDefinition = {
  method: 'get',
  path: '/api/search',
  operationId: 'search',
  tags: ['Search'],
};
