# API returns 500 on special characters in query params

## Bug Report

**Describe the bug**
Sending a GET request with special characters in query params causes a 500 Internal Server Error instead of proper handling.

**To reproduce**
```bash
# These all return 500:
curl 'http://localhost:3000/api/search?q=hello%00world'
curl 'http://localhost:3000/api/search?q=test%27%3B%20DROP%20TABLE'
curl 'http://localhost:3000/api/search?q=%F0%9F%98%80emoji'
curl 'http://localhost:3000/api/search?q=path/../../../etc/passwd'
```

**Expected behavior**
- Null bytes: stripped or rejected with 400
- SQL-like injection: properly escaped (parameterized queries)
- Unicode/emoji: handled correctly
- Path traversal: rejected with 400

**Stack trace**
```
TypeError: Cannot read properties of undefined (reading 'normalize')
    at SearchController.search (src/controllers/search.ts:42)
    at Router.handle (node_modules/express/lib/router/index.js:234)
```

**Severity**: High — this is a potential security vulnerability.