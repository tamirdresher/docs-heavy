# Review PR adding authentication

## Code Review Request

**PR**: Add JWT authentication (#42)

**Summary**
This PR adds JWT-based authentication to all protected API routes. It includes:
- Login/register endpoints
- JWT token generation and validation middleware
- Password hashing with bcrypt
- Role-based access control (admin, user)

**Review focus areas**
1. **Security**: Token generation, storage, expiration, refresh flow
2. **Password handling**: Hashing algorithm, salt rounds, timing attacks
3. **Middleware correctness**: Auth bypass vulnerabilities, error handling
4. **API design**: Endpoint naming, response formats, error messages

**Files changed** (12 files)
- `src/auth/jwt.ts` — Token generation and validation
- `src/auth/password.ts` — Password hashing utilities
- `src/middleware/auth.ts` — Authentication middleware
- `src/middleware/roles.ts` — Role-based access control
- `src/routes/auth.ts` — Login, register, refresh endpoints
- `src/models/user.ts` — User model with password field
- `tests/auth/*.test.ts` — Auth test suite

**Review deliverable**
Provide a structured review with: critical issues, suggestions, and approval/request-changes decision.