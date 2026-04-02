---
title: "Products API"
---

# Products API

## Endpoints
- `GET /api/products` — List products
- `GET /api/products/:id` — Get product
- `POST /api/products` — Create product
- `PUT /api/products/:id` — Update product
- `DELETE /api/products/:id` — Delete product

## Performance Notes

### ORM 5.4 Eager-Loading Regression (Resolved)

After upgrading the ORM from 5.2 to 5.4, the `GET /api/products` endpoint experienced a 3× latency increase (p95: 50ms → 150ms). The root cause was a change in the ORM's default eager-loading strategy from `join` to `select`, which introduced an N+1 query pattern when loading product associations (categories, images, recommendations).

**Fix:** Explicitly set `strategy: 'join'` on the product list query's `include` options. See the [full RCA](/guides/product-endpoint-perf-regression-rca) for details and recommended approaches.
