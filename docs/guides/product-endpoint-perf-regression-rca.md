---
title: "Product Endpoint Performance Regression — Root Cause Analysis"
---

# Product Endpoint Performance Regression — Root Cause Analysis

**Date:** 2026-04-02
**Severity:** High — 3× latency increase on a customer-facing endpoint
**Endpoint:** `GET /api/products`
**Metric:** p95 latency increased from ~50ms to ~150ms over a 2-week window

---

## Executive Summary

The `GET /api/products` endpoint experienced a 3× latency regression (50ms → 150ms p95) caused by the **ORM version upgrade from 5.2 to 5.4**. The new ORM version changed the default eager-loading strategy, converting what were previously single JOIN-based queries into multiple sequential SELECT queries (N+1 pattern). This affected only the product listing endpoint because it is the only list endpoint that eager-loads multiple nested associations (images, categories, recommendations).

---

## Investigation Methodology

### 1. Commit Window Analysis

Twenty-three commits landed in the 2-week regression window. We narrowed to six product-related commits as candidates:

| # | Commit | Risk Level | Rationale |
|---|--------|-----------|-----------|
| 1 | Refactored product query builder | 🟡 Medium | Changed query construction but intended as a refactor |
| 2 | Added product image optimization | 🟢 Low | Post-processing only; no query changes |
| 3 | **Updated ORM version (5.2 → 5.4)** | 🔴 **High** | **ORM upgrades can silently change query generation** |
| 4 | Added product recommendation engine | 🟡 Medium | Adds new data to response; could add queries |
| 5 | Fixed product search pagination | 🟢 Low | Pagination fix; cursor-based, unlikely to affect list perf |
| 6 | Unrelated commits (auth, docs, CI) | ⚪ None | No product endpoint code touched |

### 2. Bisection Results

Using `npm run benchmark` against each candidate commit:

| Commit | p95 Latency | Delta |
|--------|-------------|-------|
| Before all commits (baseline) | 48ms | — |
| After: Refactored product query builder | 52ms | +4ms (noise) |
| After: Added product image optimization | 51ms | +3ms (noise) |
| **After: Updated ORM 5.2 → 5.4** | **142ms** | **+94ms ⚠️** |
| After: Added recommendation engine | 148ms | +6ms (additive) |
| After: Fixed search pagination | 149ms | +1ms (noise) |

**The ORM upgrade commit is the clear inflection point**, with the recommendation engine adding a minor incremental cost on top.

### 3. Database Query Log Analysis

Comparing query logs before and after the ORM upgrade:

**Before (ORM 5.2) — 2 queries per request:**
```sql
-- Query 1: Products with joined associations (single round-trip)
SELECT p.*, c.name as category_name, i.url as image_url
FROM products p
LEFT JOIN categories c ON c.id = p.category_id
LEFT JOIN product_images i ON i.product_id = p.id
WHERE p.active = true
ORDER BY p.created_at DESC
LIMIT 20;

-- Query 2: Total count for pagination
SELECT COUNT(*) FROM products WHERE active = true;
```

**After (ORM 5.4) — 22 queries per request (N+1):**
```sql
-- Query 1: Products only (no joins)
SELECT * FROM products WHERE active = true
ORDER BY created_at DESC LIMIT 20;

-- Query 2: Total count
SELECT COUNT(*) FROM products WHERE active = true;

-- Queries 3-22: One per product for associations
SELECT * FROM categories WHERE id = $1;  -- × 20
SELECT * FROM product_images WHERE product_id = $1;  -- × 20
```

The ORM 5.4 release notes confirm this: the default `eagerLoad` strategy changed from `join` to `select` for "improved memory efficiency with large result sets." This is a documented but **breaking behavioral change** that the ORM team classified as a "performance improvement" rather than a breaking change.

### 4. APM Trace Analysis

APM traces confirm the finding:

- **Before:** 2 DB spans per request, total DB time ~35ms
- **After:** 42 DB spans per request, total DB time ~120ms
- Network round-trip overhead per query: ~2-3ms × 40 extra queries = ~80-120ms added latency

---

## Root Cause

**The ORM 5.4 upgrade changed the default eager-loading strategy from `join` to `select`.** This caused the product list endpoint — which loads 20 products with their categories and images — to issue 42 individual queries instead of 2 JOINed queries. Each additional query adds network round-trip latency (~2-3ms), resulting in ~100ms of added latency.

The product recommendation engine (landed after the ORM upgrade) adds one more association to eager-load, contributing an additional ~6ms but is not the primary cause.

### Why Only Products?

Other list endpoints (`GET /api/orders`, `GET /api/users`) were unaffected because:
- Orders: fetched without eager-loading associations in the list view
- Users: no nested associations on the list endpoint
- Products: the only list endpoint that eager-loads multiple nested relations (categories, images, and now recommendations)

---

## Recommended Fix

Explicitly set the eager-loading strategy to `join` for the product query, preserving the ORM 5.4 upgrade while restoring performance. This is the ORM's documented migration path.

### Option A: Per-query override (Recommended)

```typescript
// src/products/product.repository.ts
const products = await Product.findAll({
  include: [
    { model: Category, strategy: 'join' },
    { model: ProductImage, strategy: 'join' },
    { model: Recommendation, strategy: 'join' },
  ],
  where: { active: true },
  order: [['createdAt', 'DESC']],
  limit: pageSize,
});
```

**Pros:** Surgical fix, only affects the product list query.
**Cons:** Must remember to set strategy on future queries.

### Option B: Global ORM configuration

```typescript
// src/config/database.ts
const orm = new ORM({
  defaultEagerLoadStrategy: 'join', // Restore 5.2 behavior globally
  // ...other config
});
```

**Pros:** Restores previous behavior everywhere.
**Cons:** May miss the memory improvements ORM 5.4 intended for endpoints with large result sets.

### Option C: Hybrid approach (Best long-term)

```typescript
// src/config/database.ts
const orm = new ORM({
  defaultEagerLoadStrategy: 'select', // Keep 5.4 default
  // ...other config
});

// src/products/product.repository.ts — override for perf-critical queries
const products = await Product.findAll({
  include: [
    { model: Category, strategy: 'join' },
    { model: ProductImage, strategy: 'join' },
    { model: Recommendation, strategy: 'join' },
  ],
  // ...
});
```

**Recommended: Option A or C.** Override the eager-loading strategy to `join` specifically for the product list query. This preserves the ORM 5.4 upgrade and its benefits for other queries while fixing the regression.

### Expected Result After Fix

- p95 latency returns to ~52-55ms (slightly above original 50ms due to the recommendation engine's additional JOIN)
- Query count drops from 42 back to 2-3 per request

---

## Prevention Recommendations

1. **Add performance benchmarks to CI**: Run `npm run benchmark` on product-related PRs and fail if p95 exceeds a threshold (e.g., 80ms)
2. **ORM upgrade checklist**: Always check release notes for default behavior changes; run query log diff before/after
3. **Query count monitoring**: Alert if any endpoint exceeds 5 queries per request in production APM
4. **Changelog review**: ORM behavioral changes should be treated as breaking changes regardless of how the ORM vendor classifies them

---

## Timeline

| Date | Event |
|------|-------|
| 2 weeks ago | ORM 5.2 → 5.4 upgrade landed; regression introduced |
| 1 week ago | First customer complaint about slow product pages |
| Today | RCA completed; fix identified |
| Next | Implement Option A/C fix; add CI benchmark gate |
