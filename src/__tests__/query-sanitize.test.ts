/**
 * Tests for the query-parameter sanitiser.
 *
 * Covers null-byte stripping, path-traversal rejection, Unicode/emoji
 * handling, and edge cases for missing or non-string values.
 */

import { sanitizeQuery } from '../sanitize/query.js';

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const result = Promise.resolve().then(fn);
  return result.then(
    () => console.log(`  ✓ ${name}`),
    (e: any) => {
      console.error(`  ✗ ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  );
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function runTests() {
  console.log('Query sanitize tests:');

  // --- Null bytes ---

  await test('strips null bytes from query', async () => {
    const result = sanitizeQuery('hello\0world');
    assert(result.valid === true, 'Should be valid');
    assert(result.value === 'helloworld', `Expected "helloworld", got "${result.value}"`);
  });

  await test('strips percent-encoded null bytes (%00)', async () => {
    const result = sanitizeQuery('hello%00world');
    assert(result.valid === true, 'Should be valid');
    assert(result.value === 'helloworld', `Expected "helloworld", got "${result.value}"`);
  });

  await test('rejects string that becomes empty after null-byte stripping', async () => {
    const result = sanitizeQuery('\0');
    assert(result.valid === false, 'Should be invalid');
    assert(result.reason === 'Query parameter must not be empty', `Unexpected reason: ${result.reason}`);
  });

  // --- Path traversal ---

  await test('rejects path traversal with ../../../etc/passwd', async () => {
    const result = sanitizeQuery('path/../../../etc/passwd');
    assert(result.valid === false, 'Should be invalid');
    assert(result.reason === 'Path traversal is not allowed', `Unexpected reason: ${result.reason}`);
  });

  await test('rejects path traversal with backslashes', async () => {
    const result = sanitizeQuery('path\\..\\..\\etc\\passwd');
    assert(result.valid === false, 'Should be invalid');
    assert(result.reason === 'Path traversal is not allowed', `Unexpected reason: ${result.reason}`);
  });

  await test('allows ".." within normal text (not path traversal)', async () => {
    const result = sanitizeQuery('something..else');
    assert(result.valid === true, 'Should be valid');
    assert(result.value === 'something..else', `Expected "something..else", got "${result.value}"`);
  });

  // --- Unicode / emoji ---

  await test('handles emoji correctly', async () => {
    const result = sanitizeQuery('😀emoji');
    assert(result.valid === true, 'Should be valid');
    assert(result.value === '😀emoji', `Expected "😀emoji", got "${result.value}"`);
  });

  await test('normalises Unicode to NFC', async () => {
    // é as e + combining acute accent (NFD) → single é (NFC)
    const nfd = 'e\u0301'; // two code points
    const result = sanitizeQuery(nfd);
    assert(result.valid === true, 'Should be valid');
    assert(result.value === '\u00e9', `Expected NFC "é", got "${result.value}"`);
  });

  await test('handles mixed Unicode and ASCII', async () => {
    const result = sanitizeQuery('café ☕ naïve');
    assert(result.valid === true, 'Should be valid');
    assert(result.value!.includes('café'), 'Should contain café');
  });

  // --- SQL-like injection (should pass through — sanitiser is not responsible) ---

  await test('allows SQL-like strings (sanitiser does not block SQL)', async () => {
    const result = sanitizeQuery("test'; DROP TABLE users; --");
    assert(result.valid === true, 'Should be valid — SQL escaping is a DB concern');
    assert(result.value === "test'; DROP TABLE users; --", 'Value should be unchanged');
  });

  // --- Edge cases ---

  await test('rejects undefined', async () => {
    const result = sanitizeQuery(undefined);
    assert(result.valid === false, 'Should be invalid');
    assert(result.reason === 'Query parameter is required', `Unexpected reason: ${result.reason}`);
  });

  await test('rejects null', async () => {
    const result = sanitizeQuery(null);
    assert(result.valid === false, 'Should be invalid');
    assert(result.reason === 'Query parameter is required', `Unexpected reason: ${result.reason}`);
  });

  await test('rejects non-string (number)', async () => {
    const result = sanitizeQuery(42 as any);
    assert(result.valid === false, 'Should be invalid');
    assert(result.reason === 'Query parameter must be a string', `Unexpected reason: ${result.reason}`);
  });

  await test('rejects empty string', async () => {
    const result = sanitizeQuery('');
    assert(result.valid === false, 'Should be invalid');
    assert(result.reason === 'Query parameter must not be empty', `Unexpected reason: ${result.reason}`);
  });

  await test('accepts normal search terms', async () => {
    const result = sanitizeQuery('hello world');
    assert(result.valid === true, 'Should be valid');
    assert(result.value === 'hello world', `Expected "hello world", got "${result.value}"`);
  });

  console.log('\nAll query sanitize tests passed!');
}

runTests();
