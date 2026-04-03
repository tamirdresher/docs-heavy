/**
 * Order model.
 *
 * In-memory order store for demonstration. In production this would
 * be backed by a database (PostgreSQL, MongoDB, etc.).
 *
 * Orders support soft-delete via the `deletedAt` timestamp.
 */

import { randomUUID } from 'node:crypto';

export type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';

/**
 * Calculate the total amount for a list of order items,
 * rounded to 2 decimal places to avoid floating-point artifacts.
 */
export function calculateTotalAmount(items: OrderItem[]): number {
  const raw = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  return Math.round(raw * 100) / 100;
}

export interface OrderItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  status: OrderStatus;
  totalAmount: number;
  createdAt: string;
  updatedAt: string;
  /** Soft-delete timestamp. null means the order is active. */
  deletedAt: string | null;
}

/** Fields safe to return in API responses. */
export type PublicOrder = Order;

/**
 * In-memory order store.
 */
export class OrderStore {
  private orders = new Map<string, Order>();

  /**
   * Create a new order.
   */
  create(data: {
    userId: string;
    items: OrderItem[];
    status?: OrderStatus;
  }): Order {
    const id = this.generateId();
    const now = new Date().toISOString();
    const totalAmount = calculateTotalAmount(data.items);

    const order: Order = {
      id,
      userId: data.userId,
      items: data.items,
      status: data.status ?? 'pending',
      totalAmount,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    this.orders.set(id, order);
    return order;
  }

  /**
   * Find an order by ID. Returns undefined if not found or soft-deleted.
   */
  findById(id: string): Order | undefined {
    const order = this.orders.get(id);
    if (!order || order.deletedAt !== null) return undefined;
    return order;
  }

  /**
   * Find an order by ID, including soft-deleted orders.
   */
  findByIdIncludingDeleted(id: string): Order | undefined {
    return this.orders.get(id);
  }

  /**
   * List non-deleted orders with cursor-based pagination.
   * Optionally filter by userId.
   */
  list(options: {
    cursor?: string;
    limit?: number;
    userId?: string;
  } = {}): { items: Order[]; nextCursor: string | null; hasMore: boolean } {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

    let all = Array.from(this.orders.values())
      .filter((o) => o.deletedAt === null)
      .sort((a, b) => a.id.localeCompare(b.id));

    if (options.userId) {
      all = all.filter((o) => o.userId === options.userId);
    }

    let startIdx = 0;
    if (options.cursor) {
      const cursorIdx = all.findIndex((o) => o.id === options.cursor);
      if (cursorIdx >= 0) startIdx = cursorIdx + 1;
    }

    const page = all.slice(startIdx, startIdx + limit + 1);
    const hasMore = page.length > limit;
    const items = page.slice(0, limit);
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;

    return { items, nextCursor, hasMore };
  }

  /**
   * Update an order. Returns undefined if not found or soft-deleted.
   */
  update(id: string, changes: Partial<Pick<Order, 'items' | 'status'>>): Order | undefined {
    const order = this.findById(id);
    if (!order) return undefined;

    const now = new Date().toISOString();

    if (changes.items) {
      order.items = changes.items;
      order.totalAmount = calculateTotalAmount(changes.items);
    }
    if (changes.status !== undefined) {
      order.status = changes.status;
    }
    order.updatedAt = now;

    this.orders.set(id, order);
    return order;
  }

  /**
   * Soft-delete an order. Sets deletedAt timestamp.
   */
  softDelete(id: string): boolean {
    const order = this.findById(id);
    if (!order) return false;

    order.deletedAt = new Date().toISOString();
    order.updatedAt = order.deletedAt;
    this.orders.set(id, order);
    return true;
  }

  /**
   * Clear all orders (for testing).
   */
  clear(): void {
    this.orders.clear();
  }

  private generateId(): string {
    return randomUUID();
  }
}
