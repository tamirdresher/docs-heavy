# Fix memory leak in WebSocket handler

## Bug Report

**Describe the bug**
After running the server for ~2 hours under load, memory usage grows from 120MB to over 1.2GB. The issue correlates with WebSocket connection count.

**To reproduce**
1. Start the server with `npm start`
2. Open 500 concurrent WebSocket connections using `wscat` or load tester
3. Disconnect and reconnect clients repeatedly
4. Observe RSS memory via `process.memoryUsage()`

**Expected behavior**
Memory should stabilize after initial connections. Disconnected clients should be fully cleaned up.

**Environment**
- Node.js 20.11.0
- ws@8.16.0
- OS: Ubuntu 22.04

**Logs**
```
[warn] EventEmitter memory leak detected. 11 listeners added for 'message'.
```

**Suspected cause**
The `handleConnection` function in `src/ws/handler.ts` adds event listeners on each reconnect but never removes them on disconnect.