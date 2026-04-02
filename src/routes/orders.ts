/**
 * Order routes.
 *
 * Endpoints for managing customer orders.
 */

import type { RouteDefinition } from '../openapi/types.js';

/**
 * @openapi
 * @summary List orders
 * @description Retrieve a paginated list of orders for the authenticated user.
 * @param {number} page - Page number (query)
 * @param {number} limit - Items per page (query)
 * @response 200 { OrderList } - A paginated list of orders
 * @response 401 { Error } - Not authenticated
 */
export const listOrders: RouteDefinition = {
  method: 'get',
  path: '/api/orders',
  operationId: 'listOrders',
  tags: ['Orders'],
};

/**
 * @openapi
 * @summary Get order by ID
 * @description Retrieve a single order by its unique identifier.
 * @param {string} id - Order ID (path)
 * @response 200 { Order } - The requested order
 * @response 404 { Error } - Order not found
 */
export const getOrder: RouteDefinition = {
  method: 'get',
  path: '/api/orders/:id',
  operationId: 'getOrder',
  tags: ['Orders'],
};

/**
 * @openapi
 * @summary Create an order
 * @description Place a new order.
 * @body { CreateOrderRequest } - Order data
 * @response 201 { Order } - The created order
 * @response 400 { Error } - Validation error
 */
export const createOrder: RouteDefinition = {
  method: 'post',
  path: '/api/orders',
  operationId: 'createOrder',
  tags: ['Orders'],
};

/**
 * @openapi
 * @summary Update an order
 * @description Update an existing order by ID.
 * @param {string} id - Order ID (path)
 * @body { UpdateOrderRequest } - Updated order data
 * @response 200 { Order } - The updated order
 * @response 404 { Error } - Order not found
 */
export const updateOrder: RouteDefinition = {
  method: 'put',
  path: '/api/orders/:id',
  operationId: 'updateOrder',
  tags: ['Orders'],
};
