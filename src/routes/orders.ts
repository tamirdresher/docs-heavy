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
import type { Order, OrderStore, OrderItem, OrderStatus } from '../models/order.js';

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

/** Validation limits to prevent abuse and ensure data integrity. */
const MAX_PRODUCT_ID_LENGTH = 255;
const MAX_ITEMS_PER_ORDER = 100;
const MAX_QUANTITY = 999_999;
const MAX_UNIT_PRICE = 999_999.99;
const MAX_CURSOR_LENGTH = 1000;

/**
 * Validate an order item.
 */
function isValidOrderItem(item: unknown): item is OrderItem {
  if (typeof item !== 'object' || item === null) return false;
  const obj = item as Record<string, unknown>;
  if (typeof obj.productId !== 'string' || obj.productId.length === 0 || obj.productId.length > MAX_PRODUCT_ID_LENGTH) return false;
  if (typeof obj.quantity !== 'number' || !Number.isInteger(obj.quantity) || obj.quantity < 1 || obj.quantity > MAX_QUANTITY) return false;
  if (typeof obj.unitPrice !== 'number' || !Number.isFinite(obj.unitPrice) || obj.unitPrice < 0 || obj.unitPrice > MAX_UNIT_PRICE) return false;
  return true;
}

/**
 * Validate an array of order items.
 */
function isValidItemsArray(items: unknown): items is OrderItem[] {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS_PER_ORDER) return false;
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
          message: `items must be a non-empty array (max ${MAX_ITEMS_PER_ORDER}) of { productId: string (max ${MAX_PRODUCT_ID_LENGTH} chars), quantity: integer (1–${MAX_QUANTITY}), unitPrice: number (0–${MAX_UNIT_PRICE}) }`,
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

    if (cursor && cursor.length > MAX_CURSOR_LENGTH) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `cursor must be at most ${MAX_CURSOR_LENGTH} characters` },
      });
      return;
    }

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
      // Return 404 to prevent order ID enumeration (IDOR protection)
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Order not found' },
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
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Order not found' },
      });
      return;
    }

    // Cancelled orders cannot be modified
    if (order.status === 'cancelled') {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Cannot update a cancelled order' },
      });
      return;
    }

    const { items, status } = req.body;

    // Validate items if provided
    if (items !== undefined && !isValidItemsArray(items)) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `items must be a non-empty array (max ${MAX_ITEMS_PER_ORDER}) of { productId: string (max ${MAX_PRODUCT_ID_LENGTH} chars), quantity: integer (1–${MAX_QUANTITY}), unitPrice: number (0–${MAX_UNIT_PRICE}) }`,
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

    const changes: Partial<Pick<Order, 'items' | 'status'>> = {};
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
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Order not found' },
      });
      return;
    }

    orderStore.softDelete(id);
    res.status(204).end();
  }

  return { createOrder, listOrders, getOrder, updateOrder, deleteOrder };
}
