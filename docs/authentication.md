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
{ "email": "user@example.com", "password": "minimum8chars" }
```

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

Exchange a refresh token for a new token pair.

**Request body:**
```json
{ "refreshToken": "eyJ..." }
```

### POST /api/auth/logout

Invalidate the current session. Returns 204.

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
- JWT signatures use HMAC-SHA256 with timing-safe comparison.
- Refresh tokens cannot be used as access tokens and vice versa.
- Login errors use generic messages to prevent user enumeration.
