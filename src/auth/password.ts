/**
 * Password hashing utilities.
 *
 * Uses scrypt (Node.js built-in) for password hashing, which is
 * memory-hard and resistant to GPU/ASIC brute-force attacks.
 *
 * Hash format: `$scrypt$N=<cost>$r=<blockSize>$p=<parallel>$<salt>$<hash>`
 *
 * Security notes:
 *  - Uses 32-byte random salt per password.
 *  - Timing-safe comparison to prevent timing attacks.
 *  - Cost parameters tuned for ~100ms on modern hardware.
 */

export interface PasswordHashOptions {
  /** CPU/memory cost parameter. Default: 16384 (2^14). */
  cost?: number;
  /** Block size. Default: 8. */
  blockSize?: number;
  /** Parallelism. Default: 1. */
  parallelism?: number;
  /** Output key length in bytes. Default: 64. */
  keyLength?: number;
}

const DEFAULT_COST = 16_384;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELISM = 1;
const DEFAULT_KEY_LENGTH = 64;

/**
 * Hash a plaintext password.
 *
 * Returns a self-describing string that includes parameters and salt
 * so the hash can be verified without external configuration.
 */
export async function hashPassword(
  password: string,
  options?: PasswordHashOptions,
): Promise<string> {
  if (!password || typeof password !== 'string') {
    throw new Error('password must be a non-empty string');
  }

  const { randomBytes, scrypt } = await import('node:crypto');

  const cost = options?.cost ?? DEFAULT_COST;
  const blockSize = options?.blockSize ?? DEFAULT_BLOCK_SIZE;
  const parallelism = options?.parallelism ?? DEFAULT_PARALLELISM;
  const keyLength = options?.keyLength ?? DEFAULT_KEY_LENGTH;

  const salt = randomBytes(32);

  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: cost, r: blockSize, p: parallelism }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

  const saltB64 = salt.toString('base64');
  const hashB64 = derived.toString('base64');

  return `$scrypt$N=${cost}$r=${blockSize}$p=${parallelism}$${saltB64}$${hashB64}`;
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Uses timing-safe comparison to prevent timing side-channel attacks.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!password || typeof password !== 'string') {
    throw new Error('password must be a non-empty string');
  }
  if (!storedHash || typeof storedHash !== 'string') {
    throw new Error('storedHash must be a non-empty string');
  }

  const { scrypt, timingSafeEqual } = await import('node:crypto');

  // Parse the stored hash
  const parts = storedHash.split('$').filter(Boolean);
  // Expected: ["scrypt", "N=...", "r=...", "p=...", "<salt>", "<hash>"]
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const cost = parseInt(parts[1].replace('N=', ''), 10);
  const blockSize = parseInt(parts[2].replace('r=', ''), 10);
  const parallelism = parseInt(parts[3].replace('p=', ''), 10);
  const salt = Buffer.from(parts[4], 'base64');
  const expectedHash = Buffer.from(parts[5], 'base64');
  const keyLength = expectedHash.length;

  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: cost, r: blockSize, p: parallelism }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

  return timingSafeEqual(derived, expectedHash);
}
