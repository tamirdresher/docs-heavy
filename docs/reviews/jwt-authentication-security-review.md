---
title: "Security Review: JWT Authentication (#6)"
date: "2026-04-05"
verdict: "Request changes"
---

# Security Review: JWT Authentication (#6)

**Reviewer:** Automated Security Reviewer
**Verdict:** 🔴 Request changes (3 blocking, 3 high, 4 low)
**Files reviewed:** 7 (src/auth/jwt.ts, src/auth/password.ts, src/middleware/auth.ts, src/middleware/roles.ts, src/routes/auth.ts, src/models/user.ts, src/__tests__/auth.test.ts)

---

## Blocking Issues

### 1. Refresh tokens are non-revocable — stolen tokens grant indefinite access
**File:** `src/routes/auth.ts` — `refresh()`, `logout()`
**Severity:** 🔴 Blocking

`refresh()` accepts any valid refresh token until expiry (7 days), and `logout()` does not invalidate anything. A stolen refresh token can be replayed repeatedly for its full lifetime. Session termination is not real.

**Fix:** Add server-side refresh-token state (e.g. a `jti` claim with a Redis/in-memory set). Rotate refresh tokens on every refresh call and revoke on logout. At minimum, document this as a known limitation with a tracking issue.

### 2. `refresh()` trusts stale token claims instead of current user state
**File:** `src/routes/auth.ts:144-153`
**Severity:** 🔴 Blocking

`refresh()` reissues tokens using `payload.sub` and `payload.role` from the old token without loading the user from the store. This means:
- Deleted users can keep refreshing tokens for up to 7 days
- Users whose role was downgraded retain elevated privileges
- Disabled/banned users cannot be effectively locked out

**Fix:** Look up the user by `payload.sub` during refresh. Reject if missing/disabled. Derive the new role from the current user record, not from the old token.

### 3. No password length upper bound — scrypt DoS vector
**File:** `src/auth/password.ts` — `hashPassword()`, `src/routes/auth.ts` — `isValidPassword()`
**Severity:** 🔴 Blocking

Passwords have a minimum length (8 chars) but no maximum. Extremely large passwords (multi-MB) are fed directly into scrypt, which is deliberately CPU/memory intensive. An attacker can send oversized passwords to exhaust server resources on register and login endpoints. This is a well-known attack vector (Django enforces a 4KB cap for this reason).

**Fix:** Add a maximum password length (e.g., 128 or 1024 chars) in `isValidPassword()` before any hashing occurs.

---

## High Severity Issues

### 4. Login leaks user existence via timing side-channel
**File:** `src/routes/auth.ts` — `login()`
**Severity:** 🟡 High

When the email is unknown, login exits immediately (fast path). When the email exists but password is wrong, `verifyPassword()` runs scrypt (slow path, ~100ms). Despite the generic error message, valid emails can still be enumerated by measuring response time.

**Fix:** When the user is not found, run `verifyPassword()` against a precomputed dummy hash so both code paths have similar latency.

### 5. Registration race condition can produce 500 instead of 409
**File:** `src/routes/auth.ts` — `register()`, `src/models/user.ts` — `create()`
**Severity:** 🟡 High

`register()` does `findByEmail()` check, then later calls `create()`. Two concurrent registrations with the same email can both pass the check; one will hit the `EMAIL_EXISTS` throw from `create()`, which is unhandled — resulting in 500 instead of 409.

**Fix:** Wrap `userStore.create()` in a try/catch and map `EMAIL_EXISTS` to 409. Treat `create()` as the source of truth for uniqueness.

### 6. `verifyPassword()` can throw 500 on corrupt stored hashes
**File:** `src/auth/password.ts` — `verifyPassword()`
**Severity:** 🟡 High

Malformed or corrupted stored hashes (e.g., from a bad migration) can cause `scrypt()` to throw instead of returning `false`. This turns authentication into an unhandled 500.

**Fix:** Validate parsed parameters and base64 values before calling `scrypt`, and wrap the derivation in try/catch to fail closed with `return false`.

---

## Low Severity Issues

### 7. Bearer scheme check is case-sensitive (violates RFC 7235)
**File:** `src/middleware/auth.ts:55`
**Severity:** 🟢 Low

`parts[0] !== 'Bearer'` rejects `bearer`, `BEARER`, etc. RFC 7235 specifies auth schemes are case-insensitive.

**Fix:** Use `parts[0].toLowerCase() !== 'bearer'`. Also remove the dead `req.headers['Authorization']` fallback (Express always lowercases headers).

### 8. `logout()` sends a body with HTTP 204 No Content
**File:** `src/routes/auth.ts` — `logout()`
**Severity:** 🟢 Low

`res.status(204).json({})` violates HTTP semantics — 204 means no body. Some clients/proxies may behave unexpectedly.

**Fix:** Use `res.status(204).end()` or `res.sendStatus(204)`.

### 9. `Math.random()` for user IDs is predictable
**File:** `src/models/user.ts` — `generateId()`
**Severity:** 🟢 Low

User IDs are generated with non-cryptographic randomness, making them predictable and enumerable.

**Fix:** Use `crypto.randomUUID()`.

### 10. JWT header `alg` not validated during verification
**File:** `src/auth/jwt.ts` — `verify()`
**Severity:** 🟢 Low

`verify()` does not check that the decoded header contains `{ alg: 'HS256', typ: 'JWT' }`. This is not currently exploitable (the signature is always recomputed with HS256), but it's brittle if the implementation evolves.

**Fix:** Decode and validate the header; reject tokens whose `alg`/`typ` doesn't match expectations.

---

## Test Coverage Gaps

The test suite (41 tests) is solid but is missing scenarios for the issues above:

| Gap | Related Finding |
|-----|-----------------|
| No test for oversized password rejection | #3 |
| No test for case-insensitive `Bearer` prefix | #7 |
| No test for refresh after user deletion/role change | #2 |
| No test for duplicate registration race | #5 |
| No test for malformed stored-hash handling | #6 |
| No test for login timing consistency | #4 |

---

## Positive Observations

- ✅ **Timing-safe comparison** for both JWT signatures and passwords
- ✅ **scrypt** over bcrypt — better GPU/ASIC resistance
- ✅ **Token type enforcement** — refresh tokens rejected by auth middleware
- ✅ **Generic login errors** — prevents basic user enumeration
- ✅ **Consistent error format** — `{ error: { code, message } }` matches API conventions
- ✅ **Dependency injection** makes code testable
- ✅ **Comprehensive baseline tests** — 41 tests covering all components

---

## Verdict

**🔴 Request changes.** The implementation demonstrates solid security fundamentals (timing-safe comparison, scrypt, token type enforcement). However, the three blocking issues — non-revocable refresh tokens, stale claims on refresh, and password length DoS — must be addressed before merge. The high-severity timing side-channel and race condition should also be fixed in this PR or tracked as immediate follow-ups.
