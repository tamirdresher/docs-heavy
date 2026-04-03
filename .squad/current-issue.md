# Review PR adding new API endpoints

## Code Review Request

**PR**: Add order management endpoints (#63)

**Summary**
Adds CRUD endpoints for order management:
- `POST /api/orders` — Create order
- `GET /api/orders` — List orders (paginated)
- `GET /api/orders/:id` — Get order by ID
- `PUT /api/orders/:id` — Update order
- `DELETE /api/orders/:id` — Soft-delete order

**Review focus areas**
1. **Consistency**: Do new endpoints follow existing API conventions?
2. **Validation**: Input validation for create/update (Zod schemas)
3. **Pagination**: Cursor-based pagination matches existing endpoints
4. **Authorization**: Only order owner or admin can modify
5. **Error handling**: Consistent error response format
6. **Tests**: Each endpoint has happy-path and error-case tests

**Existing conventions** (from `/api/products` endpoints):
- Response envelope: `{ data: T, meta: { ... } }`
- Pagination: `?cursor=X&limit=20`
- Errors: `{ error: { code: string, message: string } }`
- Soft delete: sets `deletedAt` timestamp, excludes from listings