/**
 * JWT token generation and validation.
 *
 * Provides helpers for creating access tokens, refresh tokens,
 * and verifying/decoding them. Uses HMAC-SHA256 via a shared secret.
 *
 * Security considerations:
 *  - Access tokens are short-lived (15 min default).
 *  - Refresh tokens are longer-lived (7 days default).
 *  - Token payloads include `iat`, `exp`, `sub`, and `role`.
 *  - Secret must be at least 32 characters.
 */

export interface JwtPayload {
  /** Subject — user ID. */
  sub: string;
  /** User role for RBAC. */
  role: 'admin' | 'user';
  /** Issued-at timestamp (seconds since epoch). */
  iat: number;
  /** Expiration timestamp (seconds since epoch). */
  exp: number;
  /** Token type discriminator. */
  type: 'access' | 'refresh';
}

export interface JwtOptions {
  /** Secret key for HMAC-SHA256 signing. Must be ≥ 32 chars. */
  secret: string;
  /** Access token TTL in seconds. Default: 900 (15 min). */
  accessTtl?: number;
  /** Refresh token TTL in seconds. Default: 604800 (7 days). */
  refreshTtl?: number;
}

/**
 * Base64url encode a string (no padding).
 */
function base64urlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64url decode to a UTF-8 string.
 */
function base64urlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Create an HMAC-SHA256 signature for the given data.
 */
async function hmacSign(data: string, secret: string): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const sig = createHmac('sha256', secret).update(data).digest('base64');
  return sig.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const { timingSafeEqual: tse } = await import('node:crypto');
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return tse(bufA, bufB);
}

function validateOptions(opts: JwtOptions): void {
  if (!opts.secret || typeof opts.secret !== 'string') {
    throw new Error('secret is required and must be a string');
  }
  if (opts.secret.length < 32) {
    throw new Error('secret must be at least 32 characters for adequate security');
  }
  if (opts.accessTtl !== undefined && (opts.accessTtl <= 0 || !Number.isFinite(opts.accessTtl))) {
    throw new Error('accessTtl must be a positive finite number');
  }
  if (opts.refreshTtl !== undefined && (opts.refreshTtl <= 0 || !Number.isFinite(opts.refreshTtl))) {
    throw new Error('refreshTtl must be a positive finite number');
  }
}

/**
 * Create a JWT manager with the given options.
 */
export function createJwtManager(options: JwtOptions) {
  validateOptions(options);

  const { secret, accessTtl = 900, refreshTtl = 604_800 } = options;

  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

  /**
   * Generate a signed JWT token.
   * @param nowOverride - Optional override for current time (seconds). For testing only.
   */
  async function sign(
    payload: Omit<JwtPayload, 'iat' | 'exp'>,
    ttl: number,
    nowOverride?: number,
  ): Promise<string> {
    const now = nowOverride ?? Math.floor(Date.now() / 1000);
    const fullPayload: JwtPayload = {
      ...payload,
      iat: now,
      exp: now + ttl,
    };

    const encodedPayload = base64urlEncode(JSON.stringify(fullPayload));
    const data = `${header}.${encodedPayload}`;
    const signature = await hmacSign(data, secret);
    return `${data}.${signature}`;
  }

  /**
   * Verify and decode a JWT token. Returns the payload or null if invalid/expired.
   */
  async function verify(token: string): Promise<JwtPayload | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerPart, payloadPart, signaturePart] = parts;
    const expectedSig = await hmacSign(`${headerPart}.${payloadPart}`, secret);

    const valid = await timingSafeEqual(signaturePart, expectedSig);
    if (!valid) return null;

    try {
      const payload: JwtPayload = JSON.parse(base64urlDecode(payloadPart));

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp <= now) return null;

      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Generate an access token for a user.
   */
  async function generateAccessToken(userId: string, role: 'admin' | 'user'): Promise<string> {
    return sign({ sub: userId, role, type: 'access' }, accessTtl);
  }

  /**
   * Generate a refresh token for a user.
   */
  async function generateRefreshToken(userId: string, role: 'admin' | 'user'): Promise<string> {
    return sign({ sub: userId, role, type: 'refresh' }, refreshTtl);
  }

  /**
   * Generate both access and refresh tokens.
   */
  async function generateTokenPair(
    userId: string,
    role: 'admin' | 'user',
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const [accessToken, refreshToken] = await Promise.all([
      generateAccessToken(userId, role),
      generateRefreshToken(userId, role),
    ]);
    return { accessToken, refreshToken };
  }

  return { sign, verify, generateAccessToken, generateRefreshToken, generateTokenPair };
}
