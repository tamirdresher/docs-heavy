/**
 * Webhook routes.
 *
 * Endpoints for managing webhook subscriptions.
 */

import type { RouteDefinition } from '../openapi/types.js';

/**
 * @openapi
 * @summary List webhooks
 * @description Retrieve all registered webhooks for the authenticated user.
 * @response 200 { WebhookList } - A list of webhooks
 * @response 401 { Error } - Not authenticated
 */
export const listWebhooks: RouteDefinition = {
  method: 'get',
  path: '/api/webhooks',
  operationId: 'listWebhooks',
  tags: ['Webhooks'],
};

/**
 * @openapi
 * @summary Create a webhook
 * @description Register a new webhook subscription.
 * @body { CreateWebhookRequest } - Webhook configuration
 * @response 201 { Webhook } - The created webhook
 * @response 400 { Error } - Validation error
 */
export const createWebhook: RouteDefinition = {
  method: 'post',
  path: '/api/webhooks',
  operationId: 'createWebhook',
  tags: ['Webhooks'],
};

/**
 * @openapi
 * @summary Delete a webhook
 * @description Remove a webhook subscription by ID.
 * @param {string} id - Webhook ID (path)
 * @response 204 - Webhook deleted
 * @response 404 { Error } - Webhook not found
 */
export const deleteWebhook: RouteDefinition = {
  method: 'delete',
  path: '/api/webhooks/:id',
  operationId: 'deleteWebhook',
  tags: ['Webhooks'],
};
