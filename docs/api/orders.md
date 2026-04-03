---
title: "Orders API"
---

# Orders API

## Endpoints
- `POST /api/orders` — Create order
- `GET /api/orders` — List orders (paginated)
- `GET /api/orders/:id` — Get order by ID
- `PUT /api/orders/:id` — Update order
- `DELETE /api/orders/:id` — Soft-delete order

## Authentication
All endpoints require a valid Bearer token in the Authorization header.

## Authorization
- **Create**: Any authenticated user
- **List**: Users see their own orders; admins see all
- **Get/Update/Delete**: Only the order owner or an admin

## Request/Response Format

### Create Order
```http
POST /api/orders
Content-Type: application/json
Authorization: Bearer <token>

{
  "items": [
    { "productId": "prod-1", "quantity": 2, "unitPrice": 10.99 },
    { "productId": "prod-2", "quantity": 1, "unitPrice": 24.50 }
  ]
}
```

**Response** (201):
```json
{
  "data": {
    "id": "uuid",
    "userId": "user-uuid",
    "items": [...],
    "status": "pending",
    "totalAmount": 46.48,
    "createdAt": "2026-01-01T00:00:00Z",
    "updatedAt": "2026-01-01T00:00:00Z",
    "deletedAt": null
  }
}
```

### List Orders
```http
GET /api/orders?cursor=<id>&limit=20
Authorization: Bearer <token>
```

**Response** (200):
```json
{
  "data": [...],
  "meta": {
    "nextCursor": "uuid-or-null",
    "hasMore": true
  }
}
```

### Get Order
```http
GET /api/orders/:id
Authorization: Bearer <token>
```

**Response** (200):
```json
{ "data": { ... } }
```

### Update Order
```http
PUT /api/orders/:id
Content-Type: application/json
Authorization: Bearer <token>

{
  "items": [...],
  "status": "confirmed"
}
```

Valid statuses: `pending`, `confirmed`, `shipped`, `delivered`, `cancelled`.

> **Note:** `totalAmount` is automatically calculated from items and cannot be set directly.

### Delete Order (Soft-delete)
```http
DELETE /api/orders/:id
Authorization: Bearer <token>
```

**Response**: 204 No Content

## Error Responses
All errors follow the standard format:
```json
{ "error": { "code": "ERROR_CODE", "message": "Description" } }
```

| Code | HTTP | Description |
|------|------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid authentication |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `NOT_FOUND` | 404 | Order not found |
| `VALIDATION_ERROR` | 400 | Invalid input data |
