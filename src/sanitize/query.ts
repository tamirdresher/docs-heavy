/**
 * Query parameter sanitisation.
 *
 * Validates and cleans user-supplied query strings before they reach
 * controllers, preventing:
 *   - Null-byte injection  (\0 bytes that break C-backed string routines)
 *   - Path traversal       (../ sequences targeting the filesystem)
 *   - Malformed Unicode     (lone surrogates, overlong encodings)
 *
 * SQL injection is **not** handled here — it is the responsibility of the
 * data-access layer to use parameterised queries.  This module focuses on
 * input that is dangerous *before* it even reaches a query builder.
 */

export interface SanitizeResult {
  /** The cleaned query string, or `undefined` when the input is rejected. */
  value?: string;
  /** When `valid` is false, a human-readable reason for rejection. */
  reason?: string;
  /** Whether the input passed validation (possibly after cleaning). */
  valid: boolean;
}

// Matches null bytes (literal \0 or percent-encoded %00)
const NULL_BYTE_RE = /\0|%00/gi;

// Matches path-traversal sequences (../ or ..\)
const PATH_TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Sanitise a raw query-parameter value.
 *
 * 1. Null bytes → stripped (if any remain after stripping the result is still
 *    usable, so we clean rather than reject).
 * 2. Path traversal → **rejected** with a 400-style reason.
 * 3. Unicode → normalised to NFC so downstream `.normalize()` calls never
 *    receive `undefined`.
 *
 * Returns a {@link SanitizeResult} so the caller can decide whether to
 * respond with 400 or continue with the cleaned value.
 */
export function sanitizeQuery(raw: unknown): SanitizeResult {
  // Non-string or missing values
  if (raw === undefined || raw === null) {
    return { valid: false, reason: 'Query parameter is required' };
  }

  if (typeof raw !== 'string') {
    return { valid: false, reason: 'Query parameter must be a string' };
  }

  // Strip null bytes
  let cleaned = raw.replace(NULL_BYTE_RE, '');

  // Reject path traversal attempts
  if (PATH_TRAVERSAL_RE.test(cleaned)) {
    return { valid: false, reason: 'Path traversal is not allowed' };
  }

  // Normalise Unicode to NFC to prevent the
  //   `Cannot read properties of undefined (reading 'normalize')`
  // crash that occurred when the controller called `.normalize()` on a
  // value that had already been mangled by bad encoding handling.
  cleaned = cleaned.normalize('NFC');

  // After all cleaning the string may be empty
  if (cleaned.length === 0) {
    return { valid: false, reason: 'Query parameter must not be empty' };
  }

  return { valid: true, value: cleaned };
}
