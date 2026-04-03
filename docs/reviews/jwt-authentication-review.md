---
title: "Code Review: JWT Authentication (#42)"
date: "2026-04-03"
verdict: "Approve with suggestions"
---

# Code Review: Add JWT Authentication (#42)

**Reviewer:** Automated Reviewer  
**Verdict:** ✅ Approve with suggestions  
**Files reviewed:** 7 (src/auth/jwt.ts, src/auth/password.ts, src/middleware/auth.ts, src/middleware/roles.ts, src/routes/auth.ts, src/models/user.ts, src/__tests__/auth.test.ts)

---

## Summary

This PR adds a complete JWT-based authentication system with login/register endpoints, token refresh flow, password hashing, and role-based access control. The implementation follows good security practices overall.

---

## Critical Issues

### 1. Stateless JWT logout is a no-op
**File:** `src/routes/auth.ts` — `logout()`  
**Severity:** 🔴 High  

The logout endpoint returns 204 but doesn't actually invalidate the token. With stateless JWTs, the access token remains valid until expiration (15 min). For security-sensitive applications, consider:
- A server-side token blacklist (Redis set with TTL matching token expiry)
- Short access token TTL (already 15 min, which is reasonable)
- Document this limitation clearly for API consumers

### 2. No refresh token rotation
**File:** `src/routes/auth.ts` — `refresh()`  
**Severity:** 🟡 Medium  

The refresh endpoint issues new tokens but doesn't invalidate the old refresh token. This means a stolen refresh token can be used indefinitely until it expires (7 days). Implement refresh token rotation: each refresh should invalidate the previous token.

### 3. No rate limiting on auth endpoints
**Severity:** 🟡 Medium  

Login and register endpoints are vulnerable to brute-force attacks. The rate limiter from `feature/rate-limiting-middleware` should be applied with stricter limits (e.g., 5 attempts/minute per IP for login).

---

## Suggestions

### 1. Add password complexity requirements
**File:** `src/routes/auth.ts` — `isValidPassword()`  
Currently only checks length ≥ 8. Consider requiring at least one uppercase, one lowercase, and one digit.

### 2. Add email normalization note
**File:** `src/models/user.ts`  
Good: Email is lowercased and trimmed. Consider also handling `+` aliases (e.g., `user+tag@example.com` → `user@example.com`) to prevent duplicate account creation.

### 3. Consider extracting crypto ID generation
**File:** `src/models/user.ts` — `generateId()`  
The Math.random()-based ID generation works for the in-memory store but should use `crypto.randomUUID()` in production to avoid collision risk.

### 4. Add token payload versioning
**File:** `src/auth/jwt.ts`  
Consider adding a `ver` field to the JWT payload. This allows future schema changes and enables bulk token invalidation by incrementing the version.

---

## Positive Observations

- ✅ **Timing-safe comparison** used for both JWT signature and password verification — prevents timing side-channel attacks.
- ✅ **scrypt** chosen over bcrypt — better resistance to GPU/ASIC attacks due to memory-hardness.
- ✅ **Token type enforcement** — refresh tokens cannot be used as access tokens at the middleware level.
- ✅ **Generic login error messages** — "Invalid email or password" prevents user enumeration.
- ✅ **Standard error format** — uses `{ error: { code, message } }` consistent with the rest of the API.
- ✅ **Dependency injection** in route handlers makes the code testable.
- ✅ **Comprehensive test suite** — 40 tests covering JWT, passwords, middleware, RBAC, user model, and route handlers.

---

## Decision

**✅ Approve with suggestions.** The implementation is solid with good security practices. The critical items (logout no-op, missing refresh rotation) are documented limitations that should be addressed in a follow-up PR before going to production. No blocking issues.
