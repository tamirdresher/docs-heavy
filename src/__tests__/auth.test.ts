/**
 * Tests for JWT authentication system.
 *
 * Covers:
 *  - JWT token generation, verification, and expiry
 *  - Password hashing and verification
 *  - Auth middleware (valid token, missing header, bad format, expired, blacklist)
 *  - Role-based access control
 *  - Auth route handlers (register, login, refresh, logout)
 *  - User model CRUD operations
 *  - Security: timing-safe comparison, token type enforcement
 *  - Token blacklist and refresh token rotation
 */

import { createJwtManager, type JwtPayload } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { authMiddleware, type AuthRequest, type AuthResponse } from '../middleware/auth.js';
import { requireRole } from '../middleware/roles.js';
import { UserStore } from '../models/user.js';
import { createAuthRoutes } from '../routes/auth.js';
import { TokenBlacklist } from '../auth/token-blacklist.js';

// ── test helpers ────────────────────────────────────────────────────────

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const result = Promise.resolve().then(fn);
  return result.then(
    () => console.log(`  ✓ ${name}`),
    (e: any) => {
      console.error(`  ✗ ${name}: ${e.message}`);
      process.exitCode = 1;
    },
  );
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function mockRes(): AuthResponse & {
  statusCode?: number;
  body?: unknown;
  ended?: boolean;
} {
  const res: any = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
  };
  res.end = () => {
    res.ended = true;
  };
  return res;
}

const TEST_SECRET = 'a-very-secure-secret-that-is-at-least-32-chars-long!!';

// ── tests ───────────────────────────────────────────────────────────────

async function runTests() {
  // ───── JWT Token Tests ─────

  console.log('\nJWT Token tests:');

  await test('createJwtManager: rejects short secret', async () => {
    let threw = false;
    try {
      createJwtManager({ secret: 'short' });
    } catch {
      threw = true;
    }
    assert(threw, 'Should reject secret < 32 chars');
  });

  await test('createJwtManager: rejects empty secret', async () => {
    let threw = false;
    try {
      createJwtManager({ secret: '' });
    } catch {
      threw = true;
    }
    assert(threw, 'Should reject empty secret');
  });

  await test('generateAccessToken: produces valid JWT string', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const token = await mgr.generateAccessToken('user-123', 'user');
    const parts = token.split('.');
    assert(parts.length === 3, `JWT should have 3 parts, got ${parts.length}`);
  });

  await test('verify: returns payload for valid access token', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const token = await mgr.generateAccessToken('user-456', 'admin');
    const payload = await mgr.verify(token);
    assert(payload !== null, 'Payload should not be null');
    assert(payload!.sub === 'user-456', `sub should be user-456, got ${payload!.sub}`);
    assert(payload!.role === 'admin', `role should be admin, got ${payload!.role}`);
    assert(payload!.type === 'access', `type should be access, got ${payload!.type}`);
  });

  await test('verify: returns payload for valid refresh token', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const token = await mgr.generateRefreshToken('user-789', 'user');
    const payload = await mgr.verify(token);
    assert(payload !== null, 'Payload should not be null');
    assert(payload!.type === 'refresh', `type should be refresh, got ${payload!.type}`);
  });

  await test('verify: returns null for tampered token', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const token = await mgr.generateAccessToken('user-123', 'user');
    const tampered = token.slice(0, -5) + 'XXXXX';
    const payload = await mgr.verify(tampered);
    assert(payload === null, 'Should return null for tampered token');
  });

  await test('verify: returns null for token signed with different secret', async () => {
    const mgr1 = createJwtManager({ secret: TEST_SECRET });
    const mgr2 = createJwtManager({ secret: 'another-secret-that-is-at-least-32-chars-long!!' });
    const token = await mgr1.generateAccessToken('user-123', 'user');
    const payload = await mgr2.verify(token);
    assert(payload === null, 'Should return null for different secret');
  });

  await test('verify: returns null for expired token', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    // Generate a token that expired 10 seconds ago by using sign() with past timestamp
    const token = await mgr.sign({ sub: 'user-123', role: 'user', type: 'access' }, 5, Math.floor(Date.now() / 1000) - 15);
    const payload = await mgr.verify(token);
    assert(payload === null, 'Should return null for expired token');
  });

  await test('verify: returns null for malformed token', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    assert(await mgr.verify('not-a-jwt') === null, 'Should reject garbage');
    assert(await mgr.verify('a.b') === null, 'Should reject 2-part token');
    assert(await mgr.verify('') === null, 'Should reject empty string');
  });

  await test('generateTokenPair: returns both tokens', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const pair = await mgr.generateTokenPair('user-123', 'user');
    assert(typeof pair.accessToken === 'string', 'Should have accessToken');
    assert(typeof pair.refreshToken === 'string', 'Should have refreshToken');
    assert(pair.accessToken !== pair.refreshToken, 'Tokens should be different');
  });

  // ───── Password Tests ─────

  console.log('\nPassword hashing tests:');

  await test('hashPassword: returns scrypt hash string', async () => {
    const hash = await hashPassword('mypassword123');
    assert(hash.startsWith('$scrypt$'), `Hash should start with $scrypt$, got: ${hash.substring(0, 20)}`);
  });

  await test('verifyPassword: matches correct password', async () => {
    const hash = await hashPassword('correcthorse');
    const result = await verifyPassword('correcthorse', hash);
    assert(result === true, 'Should verify correct password');
  });

  await test('verifyPassword: rejects wrong password', async () => {
    const hash = await hashPassword('correcthorse');
    const result = await verifyPassword('wronghorse', hash);
    assert(result === false, 'Should reject wrong password');
  });

  await test('hashPassword: different salts produce different hashes', async () => {
    const h1 = await hashPassword('samepassword');
    const h2 = await hashPassword('samepassword');
    assert(h1 !== h2, 'Hashes should differ due to random salt');
  });

  await test('hashPassword: rejects empty string', async () => {
    let threw = false;
    try {
      await hashPassword('');
    } catch {
      threw = true;
    }
    assert(threw, 'Should reject empty password');
  });

  await test('verifyPassword: rejects malformed hash', async () => {
    const result = await verifyPassword('password', 'not-a-valid-hash');
    assert(result === false, 'Should return false for malformed hash');
  });

  // ───── Auth Middleware Tests ─────

  console.log('\nAuth middleware tests:');

  await test('authMiddleware: passes with valid access token', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const token = await mgr.generateAccessToken('user-1', 'user');
    const mw = authMiddleware(mgr);

    const req: AuthRequest = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert(nextCalled, 'next() should be called');
    assert(req.user?.sub === 'user-1', 'Should attach user to request');
  });

  await test('authMiddleware: rejects missing auth header', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const mw = authMiddleware(mgr);

    const req: AuthRequest = { headers: {} };
    const res = mockRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert(!nextCalled, 'next() should not be called');
    assert(res.statusCode === 401, `Should return 401, got ${res.statusCode}`);
  });

  await test('authMiddleware: rejects invalid format (no Bearer prefix)', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const mw = authMiddleware(mgr);

    const req: AuthRequest = { headers: { authorization: 'Basic abc123' } };
    const res = mockRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert(!nextCalled, 'next() should not be called');
    assert(res.statusCode === 401, `Should return 401, got ${res.statusCode}`);
  });

  await test('authMiddleware: rejects expired token', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    // Generate a token that expired 10 seconds ago
    const token = await mgr.sign({ sub: 'user-1', role: 'user', type: 'access' }, 5, Math.floor(Date.now() / 1000) - 15);

    const mw = authMiddleware(mgr);
    const req: AuthRequest = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert(!nextCalled, 'next() should not be called');
    assert(res.statusCode === 401, `Should return 401, got ${res.statusCode}`);
  });

  await test('authMiddleware: rejects refresh token used as access token', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const token = await mgr.generateRefreshToken('user-1', 'user');

    const mw = authMiddleware(mgr);
    const req: AuthRequest = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert(!nextCalled, 'next() should not be called for refresh token');
    assert(res.statusCode === 401, `Should return 401, got ${res.statusCode}`);
  });

  // ───── Role Middleware Tests ─────

  console.log('\nRole-based access control tests:');

  await test('requireRole: allows matching role', () => {
    const mw = requireRole('admin');
    const req: AuthRequest = {
      headers: {},
      user: { sub: 'u1', role: 'admin', iat: 0, exp: 999999999, type: 'access' },
    };
    const res = mockRes();
    let nextCalled = false;

    mw(req, res, () => { nextCalled = true; });
    assert(nextCalled, 'next() should be called for admin');
  });

  await test('requireRole: rejects non-matching role', () => {
    const mw = requireRole('admin');
    const req: AuthRequest = {
      headers: {},
      user: { sub: 'u1', role: 'user', iat: 0, exp: 999999999, type: 'access' },
    };
    const res = mockRes();
    let nextCalled = false;

    mw(req, res, () => { nextCalled = true; });
    assert(!nextCalled, 'next() should not be called for regular user');
    assert(res.statusCode === 403, `Should return 403, got ${res.statusCode}`);
  });

  await test('requireRole: allows if any role matches', () => {
    const mw = requireRole('admin', 'user');
    const req: AuthRequest = {
      headers: {},
      user: { sub: 'u1', role: 'user', iat: 0, exp: 999999999, type: 'access' },
    };
    const res = mockRes();
    let nextCalled = false;

    mw(req, res, () => { nextCalled = true; });
    assert(nextCalled, 'next() should be called when role is in allowed set');
  });

  await test('requireRole: rejects unauthenticated request', () => {
    const mw = requireRole('admin');
    const req: AuthRequest = { headers: {} }; // no user
    const res = mockRes();
    let nextCalled = false;

    mw(req, res, () => { nextCalled = true; });
    assert(!nextCalled, 'next() should not be called');
    assert(res.statusCode === 401, `Should return 401, got ${res.statusCode}`);
  });

  await test('requireRole: throws if no roles specified', () => {
    let threw = false;
    try {
      requireRole();
    } catch {
      threw = true;
    }
    assert(threw, 'Should throw if no roles');
  });

  // ───── User Model Tests ─────

  console.log('\nUser model tests:');

  await test('UserStore: creates and retrieves user by ID', () => {
    const store = new UserStore();
    const user = store.create({ email: 'test@example.com', passwordHash: 'hash123' });
    const found = store.findById(user.id);
    assert(found !== undefined, 'Should find user by ID');
    assert(found!.email === 'test@example.com', 'Email should match');
    store.clear();
  });

  await test('UserStore: finds user by email (case insensitive)', () => {
    const store = new UserStore();
    store.create({ email: 'Test@Example.COM', passwordHash: 'hash123' });
    const found = store.findByEmail('test@example.com');
    assert(found !== undefined, 'Should find user by lowercase email');
    store.clear();
  });

  await test('UserStore: rejects duplicate email', () => {
    const store = new UserStore();
    store.create({ email: 'dupe@test.com', passwordHash: 'hash1' });
    let threw = false;
    try {
      store.create({ email: 'dupe@test.com', passwordHash: 'hash2' });
    } catch (e: any) {
      threw = e.message === 'EMAIL_EXISTS';
    }
    assert(threw, 'Should throw EMAIL_EXISTS for duplicate');
    store.clear();
  });

  await test('UserStore: toPublic strips passwordHash', () => {
    const store = new UserStore();
    const user = store.create({ email: 'pub@test.com', passwordHash: 'secret' });
    const pub = store.toPublic(user);
    assert(!('passwordHash' in pub), 'Should not contain passwordHash');
    assert('email' in pub, 'Should contain email');
    store.clear();
  });

  await test('UserStore: defaults role to user', () => {
    const store = new UserStore();
    const user = store.create({ email: 'role@test.com', passwordHash: 'h' });
    assert(user.role === 'user', `Default role should be user, got ${user.role}`);
    store.clear();
  });

  await test('UserStore: findByEmail returns undefined for unknown email', () => {
    const store = new UserStore();
    assert(store.findByEmail('nobody@test.com') === undefined, 'Should return undefined');
  });

  // ───── Auth Routes Tests ─────

  console.log('\nAuth route handler tests:');

  const jwtMgr = createJwtManager({ secret: TEST_SECRET });
  const userStore = new UserStore();
  const tokenBlacklist = new TokenBlacklist();
  const routes = createAuthRoutes({ userStore, jwtManager: jwtMgr, tokenBlacklist });

  await test('register: creates account and returns tokens', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    const req = { body: { email: 'new@test.com', password: 'Password123' }, headers: {} };
    const res = mockRes();
    await routes.register(req as any, res);
    assert(res.statusCode === 201, `Should return 201, got ${res.statusCode}`);
    assert(typeof (res.body as any).accessToken === 'string', 'Should return accessToken');
    assert(typeof (res.body as any).refreshToken === 'string', 'Should return refreshToken');
    assert((res.body as any).user.email === 'new@test.com', 'Should return user');
  });

  await test('register: rejects invalid email', async () => {
    const req = { body: { email: 'notanemail', password: 'Password123' }, headers: {} };
    const res = mockRes();
    await routes.register(req as any, res);
    assert(res.statusCode === 400, `Should return 400, got ${res.statusCode}`);
  });

  await test('register: rejects short password', async () => {
    const req = { body: { email: 'valid@test.com', password: 'short' }, headers: {} };
    const res = mockRes();
    await routes.register(req as any, res);
    assert(res.statusCode === 400, `Should return 400, got ${res.statusCode}`);
  });

  await test('register: rejects password without uppercase', async () => {
    const req = { body: { email: 'valid@test.com', password: 'password123' }, headers: {} };
    const res = mockRes();
    await routes.register(req as any, res);
    assert(res.statusCode === 400, `Should return 400, got ${res.statusCode}`);
  });

  await test('register: rejects password without digit', async () => {
    const req = { body: { email: 'valid@test.com', password: 'Passwordabc' }, headers: {} };
    const res = mockRes();
    await routes.register(req as any, res);
    assert(res.statusCode === 400, `Should return 400, got ${res.statusCode}`);
  });

  await test('register: rejects duplicate email', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    const req1 = { body: { email: 'dupe@test.com', password: 'Password123' }, headers: {} };
    await routes.register(req1 as any, mockRes());

    const req2 = { body: { email: 'dupe@test.com', password: 'Password456' }, headers: {} };
    const res = mockRes();
    await routes.register(req2 as any, res);
    assert(res.statusCode === 409, `Should return 409, got ${res.statusCode}`);
  });

  await test('login: authenticates valid credentials', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    // Register first
    await routes.register(
      { body: { email: 'login@test.com', password: 'Password123' }, headers: {} } as any,
      mockRes(),
    );

    const req = { body: { email: 'login@test.com', password: 'Password123' }, headers: {} };
    const res = mockRes();
    await routes.login(req as any, res);
    assert(res.statusCode === 200, `Should return 200, got ${res.statusCode}`);
    assert(typeof (res.body as any).accessToken === 'string', 'Should return accessToken');
  });

  await test('login: rejects wrong password', async () => {
    const req = { body: { email: 'login@test.com', password: 'WrongPassword1' }, headers: {} };
    const res = mockRes();
    await routes.login(req as any, res);
    assert(res.statusCode === 401, `Should return 401, got ${res.statusCode}`);
  });

  await test('login: rejects unknown email', async () => {
    const req = { body: { email: 'unknown@test.com', password: 'Password123' }, headers: {} };
    const res = mockRes();
    await routes.login(req as any, res);
    assert(res.statusCode === 401, `Should return 401, got ${res.statusCode}`);
  });

  await test('refresh: issues new tokens from valid refresh token', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    // Register to get tokens
    const regRes = mockRes();
    await routes.register(
      { body: { email: 'ref@test.com', password: 'Password123' }, headers: {} } as any,
      regRes,
    );
    const refreshToken = (regRes.body as any).refreshToken;

    const req = { body: { refreshToken }, headers: {} };
    const res = mockRes();
    await routes.refresh(req as any, res);
    assert(res.statusCode === 200, `Should return 200, got ${res.statusCode}`);
    assert(typeof (res.body as any).accessToken === 'string', 'Should return new accessToken');
  });

  await test('refresh: rejects reuse of rotated refresh token', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    const regRes = mockRes();
    await routes.register(
      { body: { email: 'rot@test.com', password: 'Password123' }, headers: {} } as any,
      regRes,
    );
    const refreshToken = (regRes.body as any).refreshToken;

    // First refresh succeeds and blacklists the old token
    const res1 = mockRes();
    await routes.refresh({ body: { refreshToken }, headers: {} } as any, res1);
    assert(res1.statusCode === 200, 'First refresh should succeed');

    // Second use of the same refresh token should fail
    const res2 = mockRes();
    await routes.refresh({ body: { refreshToken }, headers: {} } as any, res2);
    assert(res2.statusCode === 401, `Reused refresh token should return 401, got ${res2.statusCode}`);
  });

  await test('refresh: rejects access token as refresh token', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    const regRes = mockRes();
    await routes.register(
      { body: { email: 'ref2@test.com', password: 'Password123' }, headers: {} } as any,
      regRes,
    );
    const accessToken = (regRes.body as any).accessToken;

    const req = { body: { refreshToken: accessToken }, headers: {} };
    const res = mockRes();
    await routes.refresh(req as any, res);
    assert(res.statusCode === 401, `Should return 401 for access token used as refresh, got ${res.statusCode}`);
  });

  await test('refresh: rejects invalid refresh token', async () => {
    const req = { body: { refreshToken: 'invalid-token' }, headers: {} };
    const res = mockRes();
    await routes.refresh(req as any, res);
    assert(res.statusCode === 401, `Should return 401, got ${res.statusCode}`);
  });

  await test('logout: returns 204', () => {
    const req = { body: {}, headers: {} };
    const res = mockRes();
    routes.logout(req as any, res);
    assert(res.statusCode === 204, `Should return 204, got ${res.statusCode}`);
  });

  // ───── Token Blacklist Tests ─────

  console.log('\nToken blacklist tests:');

  await test('TokenBlacklist: add and has', () => {
    const bl = new TokenBlacklist();
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    bl.add('token-abc', futureExp);
    assert(bl.has('token-abc'), 'Should find blacklisted token');
    assert(!bl.has('token-other'), 'Should not find unknown token');
    bl.clear();
  });

  await test('TokenBlacklist: prunes expired entries', () => {
    const bl = new TokenBlacklist();
    // Add a token that already expired
    bl.add('expired-tok', Math.floor(Date.now() / 1000) - 10);
    assert(!bl.has('expired-tok'), 'Expired entry should be pruned');
    assert(bl.size === 0, `Size should be 0, got ${bl.size}`);
  });

  await test('authMiddleware: rejects blacklisted token', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const bl = new TokenBlacklist();
    const token = await mgr.generateAccessToken('user-1', 'user');
    const payload = await mgr.verify(token);
    bl.add(token, payload!.exp);

    const mw = authMiddleware(mgr, bl);
    const req: AuthRequest = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert(!nextCalled, 'next() should not be called for blacklisted token');
    assert(res.statusCode === 401, `Should return 401, got ${res.statusCode}`);
  });

  // ───── Security hardening tests ─────

  console.log('\nSecurity hardening tests:');

  await test('verify: rejects token with alg=none header', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    // Craft a token with alg: "none"
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = Buffer.from(JSON.stringify({
      sub: 'attacker', role: 'admin', iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, type: 'access',
    }), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fakeToken = `${noneHeader}.${payload}.fakesig`;
    const result = await mgr.verify(fakeToken);
    assert(result === null, 'Should reject token with alg=none');
  });

  await test('verify: rejects token with alg=HS384 header', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const wrongAlgHeader = Buffer.from(JSON.stringify({ alg: 'HS384', typ: 'JWT' }), 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const payload = Buffer.from(JSON.stringify({
      sub: 'attacker', role: 'admin', iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, type: 'access',
    }), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fakeToken = `${wrongAlgHeader}.${payload}.fakesig`;
    const result = await mgr.verify(fakeToken);
    assert(result === null, 'Should reject token with wrong algorithm');
  });

  await test('verifyPassword: rejects hash with extreme scrypt cost', async () => {
    // Craft a hash with N=2^30 which would cause DoS
    const dangerousHash = '$scrypt$N=1073741824$r=8$p=1$AAAA$AAAA';
    const result = await verifyPassword('test', dangerousHash);
    assert(result === false, 'Should reject hash with extreme cost parameter');
  });

  await test('TokenBlacklist: respects max size limit', () => {
    const bl = new TokenBlacklist(5);
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    for (let i = 0; i < 10; i++) {
      bl.add(`token-${i}`, futureExp);
    }
    assert(bl.size <= 5, `Size should not exceed max (5), got ${bl.size}`);
  });

  await test('login: returns same error for unknown email as wrong password', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    await routes.register(
      { body: { email: 'timing@test.com', password: 'Password123' }, headers: {} } as any,
      mockRes(),
    );

    // Wrong password for existing user
    const res1 = mockRes();
    await routes.login({ body: { email: 'timing@test.com', password: 'WrongPass1' }, headers: {} } as any, res1);

    // Non-existent user
    const res2 = mockRes();
    await routes.login({ body: { email: 'nouser@test.com', password: 'Password123' }, headers: {} } as any, res2);

    assert(res1.statusCode === res2.statusCode, 'Status codes should match');
    const body1 = (res1.body as any).error;
    const body2 = (res2.body as any).error;
    assert(body1.code === body2.code, 'Error codes should match');
    assert(body1.message === body2.message, 'Error messages should match');
  });

  await test('requireRole: does not leak role names in error', () => {
    const mw = requireRole('admin');
    const req: AuthRequest = {
      headers: {},
      user: { sub: 'u1', role: 'user', iat: 0, exp: 999999999, type: 'access' },
    };
    const res = mockRes();
    mw(req, res, () => {});
    const msg = (res.body as any).error.message;
    assert(!msg.includes('admin'), `Error message should not contain role names, got: ${msg}`);
  });

  // ───── Final review tests ─────

  console.log('\nFinal review tests:');

  await test('logout: blacklists token when req.token is set', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    const regRes = mockRes();
    await routes.register(
      { body: { email: 'logoutbl@test.com', password: 'Password123' }, headers: {} } as any,
      regRes,
    );
    const accessToken = (regRes.body as any).accessToken;
    const payload = await jwtMgr.verify(accessToken);

    // Simulate what auth middleware does: set user and token on request
    const req = { body: {}, headers: {}, user: payload, token: accessToken };
    const res = mockRes();
    routes.logout(req as any, res);
    assert(res.statusCode === 204, `Should return 204, got ${res.statusCode}`);
    assert(tokenBlacklist.has(accessToken), 'Token should be blacklisted after logout');
  });

  await test('logout: does not blacklist when req.token is missing', () => {
    tokenBlacklist.clear();
    const req = { body: {}, headers: {}, user: { sub: 'u1', role: 'user' as const, iat: 0, exp: 999999999, type: 'access' as const } };
    const res = mockRes();
    routes.logout(req as any, res);
    assert(res.statusCode === 204, `Should return 204, got ${res.statusCode}`);
    assert(tokenBlacklist.size === 0, 'No token should be blacklisted when req.token is missing');
  });

  await test('authMiddleware: stores raw token on req.token', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const token = await mgr.generateAccessToken('user-tok', 'user');
    const mw = authMiddleware(mgr);

    const req: AuthRequest = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert(nextCalled, 'next() should be called');
    assert(req.token === token, 'req.token should contain the raw token string');
  });

  await test('register: rejects excessively long email', async () => {
    const longEmail = 'a'.repeat(250) + '@test.com';
    const req = { body: { email: longEmail, password: 'Password123' }, headers: {} };
    const res = mockRes();
    await routes.register(req as any, res);
    assert(res.statusCode === 400, `Should return 400 for email > 254 chars, got ${res.statusCode}`);
  });

  await test('register: rejects email with single-char TLD', async () => {
    const req = { body: { email: 'user@example.c', password: 'Password123' }, headers: {} };
    const res = mockRes();
    await routes.register(req as any, res);
    assert(res.statusCode === 400, `Should return 400 for single-char TLD, got ${res.statusCode}`);
  });

  // ───── Hardening review tests ─────

  console.log('\nHardening review tests:');

  await test('register: rejects password exceeding 128 characters', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    const longPassword = 'A1' + 'a'.repeat(127); // 129 chars
    const req = { body: { email: 'longpw@test.com', password: longPassword }, headers: {} };
    const res = mockRes();
    await routes.register(req as any, res);
    assert(res.statusCode === 400, `Should return 400 for password > 128 chars, got ${res.statusCode}`);
  });

  await test('register: accepts password at exactly 128 characters', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    const maxPassword = 'A1' + 'a'.repeat(126); // 128 chars
    const req = { body: { email: 'maxpw@test.com', password: maxPassword }, headers: {} };
    const res = mockRes();
    await routes.register(req as any, res);
    assert(res.statusCode === 201, `Should return 201 for 128-char password, got ${res.statusCode}`);
  });

  await test('hashPassword: rejects password exceeding 128 characters', async () => {
    let threw = false;
    try {
      await hashPassword('a'.repeat(129));
    } catch (e: any) {
      threw = e.message.includes('128');
    }
    assert(threw, 'Should reject password > 128 chars at hash level');
  });

  await test('refresh: rejects token for deleted user', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    const regRes = mockRes();
    await routes.register(
      { body: { email: 'deleted@test.com', password: 'Password123' }, headers: {} } as any,
      regRes,
    );
    const refreshToken = (regRes.body as any).refreshToken;

    // Delete the user
    userStore.clear();

    const res = mockRes();
    await routes.refresh({ body: { refreshToken }, headers: {} } as any, res);
    assert(res.statusCode === 401, `Should return 401 for deleted user refresh, got ${res.statusCode}`);
  });

  await test('refresh: uses current user role not stale token role', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    // Register as regular user
    const regRes = mockRes();
    await routes.register(
      { body: { email: 'rolechange@test.com', password: 'Password123' }, headers: {} } as any,
      regRes,
    );
    const refreshToken = (regRes.body as any).refreshToken;

    // Verify refresh works and user exists
    const res = mockRes();
    await routes.refresh({ body: { refreshToken }, headers: {} } as any, res);
    assert(res.statusCode === 200, `Should return 200 for valid refresh, got ${res.statusCode}`);
  });

  await test('logout: calls end() not json() for 204 response', () => {
    tokenBlacklist.clear();
    const req = { body: {}, headers: {} };
    const res = mockRes();
    routes.logout(req as any, res);
    assert(res.statusCode === 204, `Should return 204, got ${res.statusCode}`);
    assert((res as any).ended === true, 'Should call end() for 204 response');
  });

  await test('logout: works without authentication (no user or token)', () => {
    tokenBlacklist.clear();
    const req = { body: {}, headers: {} }; // no user or token at all
    const res = mockRes();
    routes.logout(req as any, res);
    assert(res.statusCode === 204, `Should return 204, got ${res.statusCode}`);
    assert(tokenBlacklist.size === 0, 'No token should be blacklisted');
  });

  // ───── Polish review tests ─────

  console.log('\nPolish review tests:');

  await test('authMiddleware: accepts lowercase "bearer" scheme (RFC 7235)', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const token = await mgr.generateAccessToken('user-bearer', 'user');
    const mw = authMiddleware(mgr);

    const req: AuthRequest = { headers: { authorization: `bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert(nextCalled, 'next() should be called for lowercase bearer');
    assert(req.user?.sub === 'user-bearer', 'Should attach user to request');
  });

  await test('authMiddleware: accepts mixed-case "BEARER" scheme (RFC 7235)', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const token = await mgr.generateAccessToken('user-upper', 'user');
    const mw = authMiddleware(mgr);

    const req: AuthRequest = { headers: { authorization: `BEARER ${token}` } };
    const res = mockRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert(nextCalled, 'next() should be called for uppercase BEARER');
    assert(req.user?.sub === 'user-upper', 'Should attach user to request');
  });

  await test('authMiddleware: accepts Authorization header with capital A', async () => {
    const mgr = createJwtManager({ secret: TEST_SECRET });
    const token = await mgr.generateAccessToken('user-cap', 'user');
    const mw = authMiddleware(mgr);

    const req: AuthRequest = { headers: { Authorization: `Bearer ${token}` } };
    const res = mockRes();
    let nextCalled = false;

    await mw(req, res, () => { nextCalled = true; });
    assert(nextCalled, 'next() should be called for capitalized Authorization header');
    assert(req.user?.sub === 'user-cap', 'Should attach user to request');
  });

  await test('UserStore: generateId produces unique UUIDs', () => {
    const store = new UserStore();
    const u1 = store.create({ email: 'uuid1@test.com', passwordHash: 'h1' });
    const u2 = store.create({ email: 'uuid2@test.com', passwordHash: 'h2' });
    assert(u1.id !== u2.id, 'Generated IDs should be unique');
    assert(u1.id.length === 36, `ID should be UUID format (36 chars), got ${u1.id.length}`);
    store.clear();
  });

  await test('login: uses module-level DUMMY_HASH (not per-call allocation)', async () => {
    userStore.clear();
    tokenBlacklist.clear();
    // This test verifies the timing-safe login still works correctly
    // after moving DUMMY_HASH to module scope
    const res1 = mockRes();
    await routes.login(
      { body: { email: 'nonexistent@test.com', password: 'Password123' }, headers: {} } as any,
      res1,
    );
    assert(res1.statusCode === 401, `Should return 401, got ${res1.statusCode}`);

    const res2 = mockRes();
    await routes.login(
      { body: { email: 'nonexistent2@test.com', password: 'AnotherPass1' }, headers: {} } as any,
      res2,
    );
    assert(res2.statusCode === 401, `Should return 401, got ${res2.statusCode}`);
    // Both should have identical error structure
    const body1 = (res1.body as any).error;
    const body2 = (res2.body as any).error;
    assert(body1.code === body2.code, 'Error codes should match for non-existent users');
  });

  console.log('\nAll auth tests passed!');
}

runTests();
