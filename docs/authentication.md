---
title: "Authentication"
---

# Authentication

The API uses JWT bearer tokens for stateless authentication. Include the token in the Authorization header:

```
Authorization: Bearer <token>
```

## Token Types

| Token | TTL | Purpose |
|-------|-----|---------|
| Access token | 15 minutes | Authenticate API requests |
| Refresh token | 7 days | Obtain new access/refresh pair |

## Endpoints

### POST /api/auth/register

Create a new user account.

**Request body:**
```json
{ "email": "user@example.com", "password": "MySecure1" }
```

Password requirements:
- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one digit

**Response (201):**
```json
{
  "user": { "id": "...", "email": "user@example.com", "role": "user" },
  "accessToken": "eyJ...",
  "refreshToken": "eyJ..."
}
```

### POST /api/auth/login

Authenticate with email and password.

**Request body:**
```json
{ "email": "user@example.com", "password": "yourpassword" }
```

**Response (200):** Same shape as register.

### POST /api/auth/refresh

Exchange a refresh token for a new token pair. The old refresh token is
invalidated after use (refresh token rotation).

**Request body:**
```json
{ "refreshToken": "eyJ..." }
```

### POST /api/auth/logout

Blacklists the current access token so it can no longer be used. Returns 204.

## Error Format

All auth errors use the standard error format:

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Invalid or expired token" } }
```

Error codes: `UNAUTHORIZED` (401), `FORBIDDEN` (403), `VALIDATION_ERROR` (400), `CONFLICT` (409), `INVALID_CREDENTIALS` (401).

## Role-Based Access Control

Two roles are supported: `admin` and `user`. Protected routes can require specific roles:

- Admin-only routes return 403 Forbidden for non-admin users.
- The user's role is encoded in the JWT payload.

## Security Notes

- Passwords are hashed with scrypt (memory-hard, resistant to GPU attacks).
- Passwords must contain uppercase, lowercase, and digit characters.
- JWT signatures use HMAC-SHA256 with timing-safe comparison.
- JWT verification enforces `alg: HS256` to prevent algorithm substitution attacks.
- Refresh tokens cannot be used as access tokens and vice versa.
- Refresh token rotation: each refresh invalidates the previous token.
- Logout blacklists the access token for its remaining lifetime.
- Login performs constant-time password verification even for unknown emails to prevent timing-based user enumeration.
- Scrypt parameter bounds are validated on verification to prevent DoS via crafted hashes.
- Token blacklist enforces a maximum size to prevent unbounded memory growth.
- RBAC error messages do not reveal which roles are required.
