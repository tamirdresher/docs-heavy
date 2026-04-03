/**
 * Order route handlers.
 *
 * Provides CRUD endpoints for order management.
 * Uses the standard response envelope: { data: T, meta?: { ... } }
 * Error format: { error: { code: string, message: string } }
 *
 * Endpoints:
 *  - POST   /api/orders      — Create a new order
 *  - GET    /api/orders       — List orders (paginated, cursor-based)
 *  - GET    /api/orders/:id   — Get order by ID
 *  - PUT    /api/orders/:id   — Update order (owner or admin only)
 *  - DELETE /api/orders/:id   — Soft-delete order (owner or admin only)
 */

import type { JwtPayload } from '../auth/jwt.js';
import type { OrderStore, OrderItem, OrderStatus } from '../models/order.js';

export interface OrderRouteRequest {
  body: Record<string, unknown>;
  params: Record<string, string>;
  query: Record<string, string>;
  user?: JwtPayload;
  [key: string]: unknown;
}

export interface OrderRouteResponse {
  status(code: number): OrderRouteResponse;
  json(body: unknown): void;
  end(): void;
}

export interface OrderDependencies {
  orderStore: OrderStore;
}

const VALID_STATUSES: OrderStatus[] = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];

/**
 * Validate an order item.
 */
function isValidOrderItem(item: unknown): item is OrderItem {
  if (typeof item !== 'object' || item === null) return false;
  const obj = item as Record<string, unknown>;
  if (typeof obj.productId !== 'string' || obj.productId.length === 0) return false;
  if (typeof obj.quantity !== 'number' || !Number.isInteger(obj.quantity) || obj.quantity < 1) return false;
  if (typeof obj.unitPrice !== 'number' || !Number.isFinite(obj.unitPrice) || obj.unitPrice < 0) return false;
  return true;
}

/**
 * Validate an array of order items.
 */
function isValidItemsArray(items: unknown): items is OrderItem[] {
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every(isValidOrderItem);
}

/**
 * Check if the requesting user can access (view or modify) this order.
 * Only the order owner or an admin can access.
 */
function canAccessOrder(user: JwtPayload, orderUserId: string): boolean {
  return user.role === 'admin' || user.sub === orderUserId;
}

/**
 * Create order route handlers with injected dependencies.
 */
export function createOrderRoutes(deps: OrderDependencies) {
  const { orderStore } = deps;

  /**
   * POST /api/orders
   *
   * Create a new order. Requires authentication.
   * Body: { items: [{ productId, quantity, unitPrice }] }
   */
  function createOrder(req: OrderRouteRequest, res: OrderRouteResponse): void {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const { items } = req.body;

    if (!isValidItemsArray(items)) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'items must be a non-empty array of { productId: string, quantity: number (≥1), unitPrice: number (≥0) }',
        },
      });
      return;
    }

    const order = orderStore.create({
      userId: req.user.sub,
      items: items as OrderItem[],
    });

    res.status(201).json({ data: order });
  }

  /**
   * GET /api/orders
   *
   * List orders with cursor-based pagination.
   * Admins see all orders; regular users see only their own.
   * Query params: cursor, limit
   */
  function listOrders(req: OrderRouteRequest, res: OrderRouteResponse): void {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const cursor = req.query.cursor;
    const limitStr = req.query.limit;
    const limit = limitStr ? parseInt(limitStr, 10) : 20;

    if (limitStr && (isNaN(limit) || limit < 1 || limit > 100)) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'limit must be between 1 and 100' },
      });
      return;
    }

    // Regular users only see their own orders; admins see all
    const userId = req.user.role === 'admin' ? undefined : req.user.sub;

    const result = orderStore.list({ cursor, limit, userId });

    res.status(200).json({
      data: result.items,
      meta: {
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      },
    });
  }

  /**
   * GET /api/orders/:id
   *
   * Get a single order by ID. Only the owner or admin can view.
   */
  function getOrder(req: OrderRouteRequest, res: OrderRouteResponse): void {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Order ID is required' },
      });
      return;
    }

    const order = orderStore.findById(id);

    if (!order) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Order not found' },
      });
      return;
    }

    if (!canAccessOrder(req.user, order.userId)) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'You do not have permission to view this order' },
      });
      return;
    }

    res.status(200).json({ data: order });
  }

  /**
   * PUT /api/orders/:id
   *
   * Update an order. Only the owner or admin can modify.
   * Body: { items?: [...], status?: OrderStatus }
   */
  function updateOrder(req: OrderRouteRequest, res: OrderRouteResponse): void {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Order ID is required' },
      });
      return;
    }

    const order = orderStore.findById(id);

    if (!order) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Order not found' },
      });
      return;
    }

    if (!canAccessOrder(req.user, order.userId)) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'You do not have permission to modify this order' },
      });
      return;
    }

    const { items, status } = req.body;

    // Validate items if provided
    if (items !== undefined && !isValidItemsArray(items)) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'items must be a non-empty array of { productId: string, quantity: number (≥1), unitPrice: number (≥0) }',
        },
      });
      return;
    }

    // Validate status if provided
    if (status !== undefined) {
      if (typeof status !== 'string' || !VALID_STATUSES.includes(status as OrderStatus)) {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `status must be one of: ${VALID_STATUSES.join(', ')}`,
          },
        });
        return;
      }
    }

    // Must provide at least one field to update
    if (items === undefined && status === undefined) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'At least one of items or status must be provided' },
      });
      return;
    }

    const changes: Partial<Pick<import('../models/order.js').Order, 'items' | 'status'>> = {};
    if (items !== undefined) changes.items = items as OrderItem[];
    if (status !== undefined) changes.status = status as OrderStatus;

    const updated = orderStore.update(id, changes);

    if (!updated) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Order not found' },
      });
      return;
    }

    res.status(200).json({ data: updated });
  }

  /**
   * DELETE /api/orders/:id
   *
   * Soft-delete an order. Only the owner or admin can delete.
   * Sets deletedAt timestamp; order is excluded from listings.
   */
  function deleteOrder(req: OrderRouteRequest, res: OrderRouteResponse): void {
    if (!req.user) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
      return;
    }

    const { id } = req.params;

    if (!id) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Order ID is required' },
      });
      return;
    }

    const order = orderStore.findById(id);

    if (!order) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Order not found' },
      });
      return;
    }

    if (!canAccessOrder(req.user, order.userId)) {
      res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'You do not have permission to delete this order' },
      });
      return;
    }

    orderStore.softDelete(id);
    res.status(204).end();
  }

  return { createOrder, listOrders, getOrder, updateOrder, deleteOrder };
}
