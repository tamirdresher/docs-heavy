/**
 * Central route registry.
 *
 * Re-exports all route definitions for use by the OpenAPI generator.
 */

export { listProducts, getProduct, createProduct, updateProduct, deleteProduct } from './products.js';
export { getCurrentUser, updateCurrentUser, getUserById } from './users.js';
export { listOrders, getOrder, createOrder, updateOrder } from './orders.js';
export { register, login, refreshToken, logout } from './auth.js';
export { search } from './search.js';
export { listWebhooks, createWebhook, deleteWebhook } from './webhooks.js';
