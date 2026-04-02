---
title: "Changelog"
---

# Changelog

## v1.0.1
- **Fixed:** Memory leak in WebSocket handler — event listeners are now properly removed on client disconnect, preventing unbounded memory growth during reconnect cycles.

## v1.0.0
- Initial release
- Products, Orders, Users APIs
- JWT authentication
- Webhook support
