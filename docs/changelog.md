---
title: "Changelog"
---

# Changelog

## v1.0.1 (Pending)
- **Fixed:** `GET /api/products` performance regression caused by ORM 5.4 eager-loading default change (p95: 150ms → ~52ms)
- Added product endpoint performance benchmark to CI gate
- See [RCA document](/guides/product-endpoint-perf-regression-rca) for full analysis

## v1.0.0
- Initial release
- Products, Orders, Users APIs
- JWT authentication
- Webhook support
