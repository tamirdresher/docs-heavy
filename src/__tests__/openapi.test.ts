/**
 * Tests for the OpenAPI spec generator.
 *
 * Validates JSDoc parsing, spec generation, and end-to-end integration
 * using the same lightweight test harness as the rest of the project.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractJSDocBlocks,
  isOpenAPIBlock,
  parseSummary,
  parseDescription,
  parseParams,
  parseResponses,
  parseBody,
  parseAnnotation,
  parseRouteSource,
  buildOpenAPISpec,
  generateSpec,
  validateSpec,
  toOpenAPIPath,
  buildOperation,
} from '../openapi/index.js';
import type {
  ParsedAnnotation,
  RouteDefinition,
  OpenAPISpec,
  AnnotatedRoute,
} from '../openapi/index.js';

// ── Test harness ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function test(name: string, fn: () => void | Promise<void>): void {
  testQueue.push({ name, fn });
}

interface TestEntry {
  name: string;
  fn: () => void | Promise<void>;
}
const testQueue: TestEntry[] = [];

async function runTests(): Promise<void> {
  for (const { name, fn } of testQueue) {
    console.log(`\n${name}`);
    try {
      await fn();
    } catch (err) {
      failed++;
      console.error(`  ✗ THREW: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

  if (failed > 0) {
    process.exit(1);
  }
}

// ── JSDoc block extraction ──────────────────────────────────────────────

test('extractJSDocBlocks — finds all comment blocks', () => {
  const source = `
    /** Block one */
    const a = 1;
    /**
     * Block two
     * @openapi
     */
    const b = 2;
    // not a JSDoc
    /* also not JSDoc */
  `;
  const blocks = extractJSDocBlocks(source);
  assertEq(blocks.length, 2, 'finds exactly 2 JSDoc blocks');
});

test('extractJSDocBlocks — returns empty for no blocks', () => {
  const blocks = extractJSDocBlocks('const a = 1;');
  assertEq(blocks.length, 0, 'no blocks found');
});

test('isOpenAPIBlock — detects @openapi tag', () => {
  assert(isOpenAPIBlock(' * @openapi\n * @summary Test'), 'has @openapi');
  assert(!isOpenAPIBlock(' * @summary Test'), 'no @openapi');
});

// ── Tag parsers ─────────────────────────────────────────────────────────

test('parseSummary — extracts summary', () => {
  assertEq(parseSummary(' * @summary Get product by ID'), 'Get product by ID', 'extracts summary text');
  assertEq(parseSummary(' * no summary here'), '', 'returns empty when missing');
});

test('parseDescription — extracts @description tag', () => {
  const block = ' * @description Retrieve a single product by its ID.';
  assertEq(parseDescription(block), 'Retrieve a single product by its ID.', 'extracts description');
});

test('parseDescription — falls back to first non-tag line', () => {
  const block = ' * This is a description.\n * @summary Test';
  assertEq(parseDescription(block), 'This is a description.', 'fallback description');
});

test('parseParams — extracts parameters with location', () => {
  const block = `
   * @param {string} id - Product ID (path)
   * @param {number} page - Page number (query)
  `;
  const params = parseParams(block);
  assertEq(params.length, 2, 'finds 2 params');
  assertEq(params[0].name, 'id', 'first param name');
  assertEq(params[0].type, 'string', 'first param type');
  assertEq(params[0].location, 'path', 'first param location');
  assert(params[0].required, 'path params are required');
  assertEq(params[1].name, 'page', 'second param name');
  assertEq(params[1].location, 'query', 'second param location');
  assert(!params[1].required, 'query params are not required');
});

test('parseParams — defaults to query when no location', () => {
  const block = ' * @param {string} q - Search term';
  const params = parseParams(block);
  assertEq(params.length, 1, 'finds 1 param');
  assertEq(params[0].location, 'query', 'defaults to query');
});

test('parseResponses — extracts responses with and without schema', () => {
  const block = `
   * @response 200 { Product } - The requested product
   * @response 204 - No content
   * @response 404 { Error } - Not found
  `;
  const responses = parseResponses(block);
  assertEq(responses.length, 3, 'finds 3 responses');

  assertEq(responses[0].statusCode, '200', 'first response code');
  assertEq(responses[0].schema, 'Product', 'first response schema');
  assertEq(responses[0].description, 'The requested product', 'first response description');

  assertEq(responses[1].statusCode, '204', 'second response code');
  assertEq(responses[1].schema, null, 'no schema for 204');
  assertEq(responses[1].description, 'No content', 'second response description');

  assertEq(responses[2].statusCode, '404', 'third response code');
  assertEq(responses[2].schema, 'Error', 'third response schema');
});

test('parseBody — extracts request body', () => {
  const block = ' * @body { CreateProductRequest } - Product data';
  const body = parseBody(block);
  assert(body !== null, 'body parsed');
  assertEq(body!.schema, 'CreateProductRequest', 'body schema');
  assertEq(body!.description, 'Product data', 'body description');
});

test('parseBody — returns null when no body', () => {
  const body = parseBody(' * @summary No body here');
  assertEq(body, null, 'no body');
});

// ── Full annotation parser ──────────────────────────────────────────────

test('parseAnnotation — combines all tags', () => {
  const block = `
   * @openapi
   * @summary Create a product
   * @description Add a new product to the catalog.
   * @param {string} id - Product ID (path)
   * @body { CreateProductRequest } - Product data
   * @response 201 { Product } - Created
   * @response 400 { Error } - Validation error
  `;
  const annotation = parseAnnotation(block);
  assertEq(annotation.summary, 'Create a product', 'summary');
  assertEq(annotation.description, 'Add a new product to the catalog.', 'description');
  assertEq(annotation.params.length, 1, 'one param');
  assertEq(annotation.responses.length, 2, 'two responses');
  assert(annotation.body !== null, 'has body');
  assertEq(annotation.body!.schema, 'CreateProductRequest', 'body schema');
});

// ── Route source parser ─────────────────────────────────────────────────

test('parseRouteSource — parses annotated route definitions', () => {
  const source = `
import type { RouteDefinition } from '../openapi/types.js';

/**
 * @openapi
 * @summary Get product
 * @param {string} id - Product ID (path)
 * @response 200 { Product } - Success
 */
export const getProduct: RouteDefinition = {
  method: 'get',
  path: '/api/products/:id',
  operationId: 'getProduct',
  tags: ['Products'],
};

/**
 * Not an openapi block
 */
export const helper: RouteDefinition = {
  method: 'get',
  path: '/internal',
  operationId: 'helper',
};
`;

  const routes = parseRouteSource(source);
  assertEq(routes.length, 1, 'only @openapi-annotated routes parsed');
  assertEq(routes[0].route.method, 'get', 'method');
  assertEq(routes[0].route.path, '/api/products/:id', 'path');
  assertEq(routes[0].route.operationId, 'getProduct', 'operationId');
  assertEq(routes[0].route.tags, ['Products'], 'tags');
  assertEq(routes[0].annotation.summary, 'Get product', 'annotation summary');
});

// ── Path conversion ─────────────────────────────────────────────────────

test('toOpenAPIPath — converts Express params to OpenAPI', () => {
  assertEq(toOpenAPIPath('/api/products/:id'), '/api/products/{id}', 'single param');
  assertEq(toOpenAPIPath('/api/users/:userId/orders/:orderId'), '/api/users/{userId}/orders/{orderId}', 'multiple params');
  assertEq(toOpenAPIPath('/api/search'), '/api/search', 'no params');
});

// ── Operation builder ───────────────────────────────────────────────────

test('buildOperation — creates valid operation object', () => {
  const route: RouteDefinition = {
    method: 'get',
    path: '/api/products/:id',
    operationId: 'getProduct',
    tags: ['Products'],
  };
  const annotation: ParsedAnnotation = {
    summary: 'Get product by ID',
    description: 'Retrieve a single product.',
    params: [
      { name: 'id', type: 'string', description: 'Product ID', location: 'path', required: true },
    ],
    responses: [
      { statusCode: '200', schema: 'Product', description: 'Success' },
      { statusCode: '404', schema: 'Error', description: 'Not found' },
    ],
    body: null,
  };

  const op = buildOperation(route, annotation);
  assertEq(op.operationId, 'getProduct', 'operationId set');
  assertEq(op.tags, ['Products'], 'tags set');
  assertEq(op.summary, 'Get product by ID', 'summary set');

  const params = op.parameters as Array<Record<string, unknown>>;
  assertEq(params.length, 1, 'one parameter');
  assertEq(params[0].name, 'id', 'param name');
  assertEq(params[0].in, 'path', 'param location');
  assert(params[0].required === true, 'path param required');

  const responses = op.responses as Record<string, Record<string, unknown>>;
  assert('200' in responses, 'has 200 response');
  assert('404' in responses, 'has 404 response');
});

test('buildOperation — includes request body', () => {
  const route: RouteDefinition = {
    method: 'post',
    path: '/api/products',
    operationId: 'createProduct',
    tags: ['Products'],
  };
  const annotation: ParsedAnnotation = {
    summary: 'Create a product',
    description: '',
    params: [],
    responses: [{ statusCode: '201', schema: 'Product', description: 'Created' }],
    body: { schema: 'CreateProductRequest', description: 'Product data' },
  };

  const op = buildOperation(route, annotation);
  const body = op.requestBody as Record<string, unknown>;
  assert(body !== undefined, 'has request body');
  assertEq(body.required, true, 'body is required');
  assertEq(body.description, 'Product data', 'body description');
});

test('buildOperation — adds default response when none specified', () => {
  const route: RouteDefinition = {
    method: 'get',
    path: '/api/health',
    operationId: 'healthCheck',
  };
  const annotation: ParsedAnnotation = {
    summary: 'Health check',
    description: '',
    params: [],
    responses: [],
    body: null,
  };

  const op = buildOperation(route, annotation);
  const responses = op.responses as Record<string, unknown>;
  assert('200' in responses, 'default 200 response added');
});

// ── Spec generator ──────────────────────────────────────────────────────

test('generateSpec — creates valid OpenAPI 3.0.3 document', () => {
  const routes: AnnotatedRoute[] = [
    {
      route: { method: 'get', path: '/api/products', operationId: 'listProducts', tags: ['Products'] },
      annotation: {
        summary: 'List products',
        description: '',
        params: [{ name: 'page', type: 'number', description: 'Page', location: 'query', required: false }],
        responses: [{ statusCode: '200', schema: 'ProductList', description: 'Success' }],
        body: null,
      },
    },
    {
      route: { method: 'post', path: '/api/products', operationId: 'createProduct', tags: ['Products'] },
      annotation: {
        summary: 'Create product',
        description: '',
        params: [],
        responses: [{ statusCode: '201', schema: 'Product', description: 'Created' }],
        body: { schema: 'CreateProductRequest', description: 'Product data' },
      },
    },
  ];

  const spec = generateSpec(routes, {
    title: 'Test API',
    version: '1.0.0',
    description: 'Test description',
    serverUrl: 'https://api.example.com',
  });

  assertEq(spec.openapi, '3.0.3', 'OpenAPI version');
  assertEq(spec.info.title, 'Test API', 'title');
  assertEq(spec.info.version, '1.0.0', 'version');
  assertEq(spec.info.description, 'Test description', 'description');
  assertEq(spec.servers![0].url, 'https://api.example.com', 'server URL');

  assert('/api/products' in spec.paths, 'path /api/products present');
  const pathItem = spec.paths['/api/products'] as Record<string, unknown>;
  assert('get' in pathItem, 'GET operation present');
  assert('post' in pathItem, 'POST operation present');

  // Check schemas were collected
  assert('ProductList' in spec.components.schemas, 'ProductList schema collected');
  assert('Product' in spec.components.schemas, 'Product schema collected');
  assert('CreateProductRequest' in spec.components.schemas, 'CreateProductRequest schema collected');
});

test('generateSpec — converts path params to OpenAPI style', () => {
  const routes: AnnotatedRoute[] = [
    {
      route: { method: 'get', path: '/api/products/:id', operationId: 'getProduct' },
      annotation: {
        summary: 'Get product',
        description: '',
        params: [],
        responses: [{ statusCode: '200', schema: null, description: 'OK' }],
        body: null,
      },
    },
  ];

  const spec = generateSpec(routes, { title: 'Test', version: '1.0.0' });
  assert('/api/products/{id}' in spec.paths, 'path uses {id} format');
  assert(!('/api/products/:id' in spec.paths), 'no Express-style path');
});

// ── Spec validation ─────────────────────────────────────────────────────

test('validateSpec — passes for valid spec', () => {
  const spec: OpenAPISpec = {
    openapi: '3.0.3',
    info: { title: 'Test', version: '1.0.0' },
    paths: {
      '/api/test': {
        get: { responses: { '200': { description: 'OK' } } },
      },
    },
    components: { schemas: {} },
  };
  const errors = validateSpec(spec);
  assertEq(errors.length, 0, 'no validation errors');
});

test('validateSpec — reports missing title', () => {
  const spec: OpenAPISpec = {
    openapi: '3.0.3',
    info: { title: '', version: '1.0.0' },
    paths: {},
    components: { schemas: {} },
  };
  const errors = validateSpec(spec);
  assert(errors.some((e) => e.includes('title')), 'reports missing title');
});

test('validateSpec — reports missing responses', () => {
  const spec: OpenAPISpec = {
    openapi: '3.0.3',
    info: { title: 'Test', version: '1.0.0' },
    paths: {
      '/api/test': {
        get: { summary: 'No responses' },
      },
    },
    components: { schemas: {} },
  };
  const errors = validateSpec(spec);
  assert(errors.some((e) => e.includes('responses')), 'reports missing responses');
});

// ── Integration: end-to-end spec generation ─────────────────────────────

test('buildOpenAPISpec — generates spec from route files', async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const routesDir = join(__dirname, '..', 'routes');

  const spec = await buildOpenAPISpec(routesDir, {
    title: 'Experiment API',
    version: '1.0.0',
    description: 'Auto-generated API documentation',
    serverUrl: 'https://experiment-docs.example.com',
  });

  // Structural checks
  assertEq(spec.openapi, '3.0.3', 'OpenAPI version is 3.0.3');
  assertEq(spec.info.title, 'Experiment API', 'API title');

  // All routes from docs should be present
  const paths = Object.keys(spec.paths);
  assert(paths.length >= 13, `at least 13 paths (got ${paths.length})`);

  // Check specific known paths
  assert(paths.includes('/api/products'), '/api/products present');
  assert(paths.includes('/api/products/{id}'), '/api/products/{id} present');
  assert(paths.includes('/api/users/me'), '/api/users/me present');
  assert(paths.includes('/api/orders'), '/api/orders present');
  assert(paths.includes('/api/auth/login'), '/api/auth/login present');
  assert(paths.includes('/api/search'), '/api/search present');
  assert(paths.includes('/api/webhooks'), '/api/webhooks present');

  // Validate the spec
  const errors = validateSpec(spec);
  assertEq(errors.length, 0, 'generated spec passes validation');

  // Check that operations have expected properties
  const productsPath = spec.paths['/api/products'] as Record<string, Record<string, unknown>>;
  assertEq(productsPath.get?.operationId, 'listProducts', 'listProducts operationId');
  assertEq(productsPath.post?.operationId, 'createProduct', 'createProduct operationId');
  assert(Array.isArray(productsPath.get?.parameters), 'list has parameters');

  // Check component schemas were collected
  const schemas = Object.keys(spec.components.schemas);
  assert(schemas.length > 0, `schemas collected (got ${schemas.length})`);
  assert(schemas.includes('Product'), 'Product schema present');
  assert(schemas.includes('Error'), 'Error schema present');
});

test('buildOpenAPISpec — spec JSON serializes correctly', async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const routesDir = join(__dirname, '..', 'routes');

  const spec = await buildOpenAPISpec(routesDir, {
    title: 'Test API',
    version: '1.0.0',
  });

  const json = JSON.stringify(spec, null, 2);
  const parsed = JSON.parse(json);

  assertEq(parsed.openapi, '3.0.3', 'round-trips through JSON');
  assert(typeof json === 'string' && json.length > 100, 'produces non-trivial JSON');
});

// ── Run ─────────────────────────────────────────────────────────────────

runTests();
