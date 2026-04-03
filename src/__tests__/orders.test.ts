/**
 * Tests for order management endpoints.
 *
 * Covers:
 *  - Order model: create, findById, list, update, soft-delete
 *  - Order routes: create, list, get, update, delete
 *  - Authorization: owner-only and admin access
 *  - Validation: items array, status values, pagination
 *  - Soft-delete: excluded from listings, not returned by findById
 *  - Pagination: cursor-based with limit
 */

import { OrderStore } from '../models/order.js';
import { createOrderRoutes } from '../routes/orders.js';
import type { JwtPayload } from '../auth/jwt.js';

// ── test helpers ────────────────────────────────────────────────────────

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const result = Promise.resolve().then(fn);
  return result.then(
    () => console.log(`  ✓ ${name}`),
    (e: any) => {
      console.error(`  ✗ ${name}: ${e.message}`);
      process.exitCode = 1;
    },
  );
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function mockRes(): {
  status(code: number): any;
  json(body: unknown): void;
  end(): void;
  statusCode?: number;
  body?: any;
  ended?: boolean;
} {
  const res: any = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
  };
  res.end = () => {
    res.ended = true;
  };
  return res;
}

function makeUser(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'user-1',
    role: 'user',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    type: 'access',
    ...overrides,
  };
}

function makeAdmin(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return makeUser({ sub: 'admin-1', role: 'admin', ...overrides });
}

const VALID_ITEMS = [
  { productId: 'prod-1', quantity: 2, unitPrice: 10.99 },
  { productId: 'prod-2', quantity: 1, unitPrice: 24.50 },
];

// ── tests ───────────────────────────────────────────────────────────────

async function runTests() {
  // ───── Order Model Tests ─────

  console.log('\nOrder Model tests:');

  await test('OrderStore.create: creates order with correct defaults', () => {
    const store = new OrderStore();
    const order = store.create({ userId: 'u1', items: VALID_ITEMS });
    assert(order.id !== undefined, 'should have id');
    assert(order.userId === 'u1', 'should have userId');
    assert(order.status === 'pending', 'default status should be pending');
    assert(order.deletedAt === null, 'deletedAt should be null');
    assert(order.totalAmount === 46.48, 'totalAmount should be calculated');
    assert(order.items.length === 2, 'should have 2 items');
  });

  await test('OrderStore.create: calculates totalAmount correctly', () => {
    const store = new OrderStore();
    const order = store.create({
      userId: 'u1',
      items: [{ productId: 'p1', quantity: 3, unitPrice: 5.00 }],
    });
    assert(order.totalAmount === 15.00, 'totalAmount should be 15.00');
  });

  await test('OrderStore.findById: returns order', () => {
    const store = new OrderStore();
    const created = store.create({ userId: 'u1', items: VALID_ITEMS });
    const found = store.findById(created.id);
    assert(found !== undefined, 'should find order');
    assert(found!.id === created.id, 'should match id');
  });

  await test('OrderStore.findById: returns undefined for non-existent', () => {
    const store = new OrderStore();
    const found = store.findById('non-existent');
    assert(found === undefined, 'should return undefined');
  });

  await test('OrderStore.findById: excludes soft-deleted orders', () => {
    const store = new OrderStore();
    const order = store.create({ userId: 'u1', items: VALID_ITEMS });
    store.softDelete(order.id);
    const found = store.findById(order.id);
    assert(found === undefined, 'should not find soft-deleted order');
  });

  await test('OrderStore.list: returns all non-deleted orders', () => {
    const store = new OrderStore();
    store.create({ userId: 'u1', items: VALID_ITEMS });
    store.create({ userId: 'u1', items: VALID_ITEMS });
    const deleted = store.create({ userId: 'u1', items: VALID_ITEMS });
    store.softDelete(deleted.id);
    const result = store.list();
    assert(result.items.length === 2, 'should return 2 non-deleted orders');
    assert(result.hasMore === false, 'should not have more');
  });

  await test('OrderStore.list: filters by userId', () => {
    const store = new OrderStore();
    store.create({ userId: 'u1', items: VALID_ITEMS });
    store.create({ userId: 'u2', items: VALID_ITEMS });
    const result = store.list({ userId: 'u1' });
    assert(result.items.length === 1, 'should return 1 order for u1');
    assert(result.items[0].userId === 'u1', 'should be u1 order');
  });

  await test('OrderStore.list: cursor-based pagination', () => {
    const store = new OrderStore();
    for (let i = 0; i < 5; i++) {
      store.create({ userId: 'u1', items: VALID_ITEMS });
    }
    const page1 = store.list({ limit: 2 });
    assert(page1.items.length === 2, 'page 1 should have 2 items');
    assert(page1.hasMore === true, 'should have more');
    assert(page1.nextCursor !== null, 'should have cursor');

    const page2 = store.list({ limit: 2, cursor: page1.nextCursor! });
    assert(page2.items.length === 2, 'page 2 should have 2 items');
    assert(page2.hasMore === true, 'should have more');

    const page3 = store.list({ limit: 2, cursor: page2.nextCursor! });
    assert(page3.items.length === 1, 'page 3 should have 1 item');
    assert(page3.hasMore === false, 'should not have more');
    assert(page3.nextCursor === null, 'no more cursor');
  });

  await test('OrderStore.update: updates items and recalculates total', () => {
    const store = new OrderStore();
    const order = store.create({ userId: 'u1', items: VALID_ITEMS });
    const newItems = [{ productId: 'p3', quantity: 1, unitPrice: 100 }];
    const updated = store.update(order.id, { items: newItems });
    assert(updated !== undefined, 'should return updated order');
    assert(updated!.items.length === 1, 'should have 1 item');
    assert(updated!.totalAmount === 100, 'total should be recalculated');
  });

  await test('OrderStore.update: updates status', () => {
    const store = new OrderStore();
    const order = store.create({ userId: 'u1', items: VALID_ITEMS });
    const updated = store.update(order.id, { status: 'confirmed' });
    assert(updated !== undefined, 'should return updated order');
    assert(updated!.status === 'confirmed', 'status should be confirmed');
  });

  await test('OrderStore.update: returns undefined for non-existent', () => {
    const store = new OrderStore();
    const result = store.update('nope', { status: 'confirmed' });
    assert(result === undefined, 'should return undefined');
  });

  await test('OrderStore.softDelete: sets deletedAt', () => {
    const store = new OrderStore();
    const order = store.create({ userId: 'u1', items: VALID_ITEMS });
    const result = store.softDelete(order.id);
    assert(result === true, 'should return true');
    const found = store.findByIdIncludingDeleted(order.id);
    assert(found !== undefined, 'should exist including deleted');
    assert(found!.deletedAt !== null, 'deletedAt should be set');
  });

  await test('OrderStore.softDelete: returns false for non-existent', () => {
    const store = new OrderStore();
    const result = store.softDelete('nope');
    assert(result === false, 'should return false');
  });

  await test('OrderStore.clear: removes all orders', () => {
    const store = new OrderStore();
    store.create({ userId: 'u1', items: VALID_ITEMS });
    store.clear();
    assert(store.list().items.length === 0, 'should be empty');
  });

  // ───── Order Route Tests — Create ─────

  console.log('\nOrder Route tests — Create:');

  await test('POST /api/orders: creates order (201)', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: { items: VALID_ITEMS }, params: {}, query: {}, user: makeUser() };
    const res = mockRes();
    routes.createOrder(req, res);
    assert(res.statusCode === 201, `expected 201, got ${res.statusCode}`);
    assert(res.body.data !== undefined, 'should have data envelope');
    assert(res.body.data.userId === 'user-1', 'userId should match');
    assert(res.body.data.status === 'pending', 'status should be pending');
  });

  await test('POST /api/orders: rejects empty items (400)', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: { items: [] }, params: {}, query: {}, user: makeUser() };
    const res = mockRes();
    routes.createOrder(req, res);
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
    assert(res.body.error.code === 'VALIDATION_ERROR', 'should be VALIDATION_ERROR');
  });

  await test('POST /api/orders: rejects missing items (400)', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: {}, query: {}, user: makeUser() };
    const res = mockRes();
    routes.createOrder(req, res);
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
  });

  await test('POST /api/orders: rejects invalid item fields (400)', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = {
      body: { items: [{ productId: '', quantity: 0, unitPrice: -1 }] },
      params: {}, query: {}, user: makeUser(),
    };
    const res = mockRes();
    routes.createOrder(req, res);
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
  });

  await test('POST /api/orders: rejects NaN unitPrice (400)', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = {
      body: { items: [{ productId: 'p1', quantity: 1, unitPrice: NaN }] },
      params: {}, query: {}, user: makeUser(),
    };
    const res = mockRes();
    routes.createOrder(req, res);
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
    assert(res.body.error.code === 'VALIDATION_ERROR', 'should be VALIDATION_ERROR');
  });

  await test('POST /api/orders: rejects Infinity unitPrice (400)', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = {
      body: { items: [{ productId: 'p1', quantity: 1, unitPrice: Infinity }] },
      params: {}, query: {}, user: makeUser(),
    };
    const res = mockRes();
    routes.createOrder(req, res);
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
    assert(res.body.error.code === 'VALIDATION_ERROR', 'should be VALIDATION_ERROR');
  });

  await test('POST /api/orders: rejects unauthenticated (401)', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: { items: VALID_ITEMS }, params: {}, query: {} };
    const res = mockRes();
    routes.createOrder(req, res);
    assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
    assert(res.body.error.code === 'UNAUTHORIZED', 'should be UNAUTHORIZED');
  });

  // ───── Order Route Tests — List ─────

  console.log('\nOrder Route tests — List:');

  await test('GET /api/orders: lists user orders (200)', () => {
    const orderStore = new OrderStore();
    orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    orderStore.create({ userId: 'user-2', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: {}, query: {}, user: makeUser() };
    const res = mockRes();
    routes.listOrders(req, res);
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
    assert(res.body.data.length === 1, 'user should only see own orders');
    assert(res.body.meta !== undefined, 'should have meta');
  });

  await test('GET /api/orders: admin sees all orders (200)', () => {
    const orderStore = new OrderStore();
    orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    orderStore.create({ userId: 'user-2', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: {}, query: {}, user: makeAdmin() };
    const res = mockRes();
    routes.listOrders(req, res);
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
    assert(res.body.data.length === 2, 'admin should see all orders');
  });

  await test('GET /api/orders: pagination with cursor and limit', () => {
    const orderStore = new OrderStore();
    for (let i = 0; i < 3; i++) {
      orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    }
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: {}, query: { limit: '1' }, user: makeUser() };
    const res = mockRes();
    routes.listOrders(req, res);
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
    assert(res.body.data.length === 1, 'should return 1 item');
    assert(res.body.meta.hasMore === true, 'should have more');
    assert(res.body.meta.nextCursor !== null, 'should have cursor');
  });

  await test('GET /api/orders: invalid limit returns 400', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: {}, query: { limit: '999' }, user: makeUser() };
    const res = mockRes();
    routes.listOrders(req, res);
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
  });

  await test('GET /api/orders: unauthenticated returns 401', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: {}, query: {} };
    const res = mockRes();
    routes.listOrders(req, res);
    assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });

  // ───── Order Route Tests — Get ─────

  console.log('\nOrder Route tests — Get:');

  await test('GET /api/orders/:id: returns order for owner (200)', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.getOrder(req, res);
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
    assert(res.body.data.id === order.id, 'should return correct order');
  });

  await test('GET /api/orders/:id: returns order for admin (200)', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: order.id }, query: {}, user: makeAdmin() };
    const res = mockRes();
    routes.getOrder(req, res);
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
  });

  await test('GET /api/orders/:id: returns 404 for non-existent', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: 'nope' }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.getOrder(req, res);
    assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`);
    assert(res.body.error.code === 'NOT_FOUND', 'should be NOT_FOUND');
  });

  await test('GET /api/orders/:id: returns 403 for non-owner', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'other-user', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.getOrder(req, res);
    assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`);
    assert(res.body.error.code === 'FORBIDDEN', 'should be FORBIDDEN');
  });

  await test('GET /api/orders/:id: unauthenticated returns 401', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: order.id }, query: {} };
    const res = mockRes();
    routes.getOrder(req, res);
    assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });

  // ───── Order Route Tests — Update ─────

  console.log('\nOrder Route tests — Update:');

  await test('PUT /api/orders/:id: updates items (200)', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const newItems = [{ productId: 'p3', quantity: 5, unitPrice: 20 }];
    const req: any = { body: { items: newItems }, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.updateOrder(req, res);
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
    assert(res.body.data.totalAmount === 100, 'totalAmount should be recalculated');
  });

  await test('PUT /api/orders/:id: updates status (200)', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: { status: 'shipped' }, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.updateOrder(req, res);
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
    assert(res.body.data.status === 'shipped', 'status should be shipped');
  });

  await test('PUT /api/orders/:id: admin can update others (200)', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: { status: 'confirmed' }, params: { id: order.id }, query: {}, user: makeAdmin() };
    const res = mockRes();
    routes.updateOrder(req, res);
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
  });

  await test('PUT /api/orders/:id: updates both items and status (200)', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const newItems = [{ productId: 'p3', quantity: 2, unitPrice: 50 }];
    const req: any = { body: { items: newItems, status: 'confirmed' }, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.updateOrder(req, res);
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`);
    assert(res.body.data.status === 'confirmed', 'status should be confirmed');
    assert(res.body.data.totalAmount === 100, 'totalAmount should be recalculated');
    assert(res.body.data.items.length === 1, 'should have 1 item');
  });

  await test('PUT /api/orders/:id: returns 404 for non-existent', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: { status: 'confirmed' }, params: { id: 'nope' }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.updateOrder(req, res);
    assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`);
  });

  await test('PUT /api/orders/:id: returns 403 for non-owner', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'other-user', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: { status: 'confirmed' }, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.updateOrder(req, res);
    assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`);
  });

  await test('PUT /api/orders/:id: rejects invalid status (400)', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: { status: 'invalid' }, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.updateOrder(req, res);
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
    assert(res.body.error.code === 'VALIDATION_ERROR', 'should be VALIDATION_ERROR');
  });

  await test('PUT /api/orders/:id: rejects empty body (400)', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.updateOrder(req, res);
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
  });

  await test('PUT /api/orders/:id: unauthenticated returns 401', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: { status: 'confirmed' }, params: { id: order.id }, query: {} };
    const res = mockRes();
    routes.updateOrder(req, res);
    assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });

  // ───── Order Route Tests — Delete ─────

  console.log('\nOrder Route tests — Delete:');

  await test('DELETE /api/orders/:id: soft-deletes order (204)', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.deleteOrder(req, res);
    assert(res.statusCode === 204, `expected 204, got ${res.statusCode}`);
    assert(res.ended === true, 'should call end()');
    // Verify soft-delete
    assert(orderStore.findById(order.id) === undefined, 'should not find via findById');
    const raw = orderStore.findByIdIncludingDeleted(order.id);
    assert(raw !== undefined, 'should still exist including deleted');
    assert(raw!.deletedAt !== null, 'deletedAt should be set');
  });

  await test('DELETE /api/orders/:id: admin can delete others (204)', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: order.id }, query: {}, user: makeAdmin() };
    const res = mockRes();
    routes.deleteOrder(req, res);
    assert(res.statusCode === 204, `expected 204, got ${res.statusCode}`);
  });

  await test('DELETE /api/orders/:id: returns 404 for non-existent', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: 'nope' }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.deleteOrder(req, res);
    assert(res.statusCode === 404, `expected 404, got ${res.statusCode}`);
  });

  await test('DELETE /api/orders/:id: returns 403 for non-owner', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'other-user', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.deleteOrder(req, res);
    assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`);
  });

  await test('DELETE /api/orders/:id: unauthenticated returns 401', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: order.id }, query: {} };
    const res = mockRes();
    routes.deleteOrder(req, res);
    assert(res.statusCode === 401, `expected 401, got ${res.statusCode}`);
  });

  await test('DELETE /api/orders/:id: double-delete returns 404', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: { id: order.id }, query: {}, user: makeUser() };
    const res1 = mockRes();
    routes.deleteOrder(req, res1);
    assert(res1.statusCode === 204, 'first delete should succeed');

    const res2 = mockRes();
    routes.deleteOrder(req, res2);
    assert(res2.statusCode === 404, 'second delete should return 404');
  });

  // ───── Soft-delete integration tests ─────

  console.log('\nSoft-delete integration tests:');

  await test('Soft-deleted orders excluded from list', () => {
    const orderStore = new OrderStore();
    const o1 = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    orderStore.softDelete(o1.id);
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: {}, params: {}, query: {}, user: makeUser() };
    const res = mockRes();
    routes.listOrders(req, res);
    assert(res.body.data.length === 1, 'should only return non-deleted');
  });

  await test('Soft-deleted order cannot be updated', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'user-1', items: VALID_ITEMS });
    orderStore.softDelete(order.id);
    const routes = createOrderRoutes({ orderStore });
    const req: any = { body: { status: 'confirmed' }, params: { id: order.id }, query: {}, user: makeUser() };
    const res = mockRes();
    routes.updateOrder(req, res);
    assert(res.statusCode === 404, 'should return 404 for soft-deleted');
  });

  // ───── Floating-point & edge-case tests ─────

  console.log('\nFloating-point & edge-case tests:');

  await test('totalAmount rounds to 2 decimal places', () => {
    const orderStore = new OrderStore();
    // 0.1 + 0.2 = 0.30000000000000004 without rounding
    const order = orderStore.create({
      userId: 'u1',
      items: [
        { productId: 'p1', quantity: 1, unitPrice: 0.1 },
        { productId: 'p2', quantity: 1, unitPrice: 0.2 },
      ],
    });
    assert(order.totalAmount === 0.3, `expected 0.3, got ${order.totalAmount}`);
  });

  await test('totalAmount rounds correctly on update', () => {
    const orderStore = new OrderStore();
    const order = orderStore.create({ userId: 'u1', items: VALID_ITEMS });
    const updated = orderStore.update(order.id, {
      items: [
        { productId: 'p1', quantity: 3, unitPrice: 0.1 },
        { productId: 'p2', quantity: 7, unitPrice: 0.2 },
      ],
    });
    // 3*0.1 + 7*0.2 = 0.3 + 1.4 = 1.7
    assert(updated!.totalAmount === 1.7, `expected 1.7, got ${updated!.totalAmount}`);
  });

  await test('POST /api/orders: rejects NaN quantity (400)', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = {
      body: { items: [{ productId: 'p1', quantity: NaN, unitPrice: 10 }] },
      params: {}, query: {}, user: makeUser(),
    };
    const res = mockRes();
    routes.createOrder(req, res);
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
    assert(res.body.error.code === 'VALIDATION_ERROR', 'should be VALIDATION_ERROR');
  });

  await test('POST /api/orders: rejects fractional quantity (400)', () => {
    const orderStore = new OrderStore();
    const routes = createOrderRoutes({ orderStore });
    const req: any = {
      body: { items: [{ productId: 'p1', quantity: 1.5, unitPrice: 10 }] },
      params: {}, query: {}, user: makeUser(),
    };
    const res = mockRes();
    routes.createOrder(req, res);
    assert(res.statusCode === 400, `expected 400, got ${res.statusCode}`);
    assert(res.body.error.code === 'VALIDATION_ERROR', 'should be VALIDATION_ERROR');
  });

  console.log('\nAll order tests completed.');
}

runTests();
