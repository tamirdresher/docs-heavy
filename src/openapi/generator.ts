/**
 * OpenAPI 3.0.3 spec generator.
 *
 * Consumes annotated route definitions and produces a valid OpenAPI document.
 */

import type {
  OpenAPISpec,
  OpenAPIGeneratorOptions,
  RouteDefinition,
  ParsedAnnotation,
} from './types.js';
import type { AnnotatedRoute } from './parser.js';

// ── Path conversion ─────────────────────────────────────────────────────

/**
 * Convert Express-style path params (`:id`) to OpenAPI-style (`{id}`).
 */
export function toOpenAPIPath(expressPath: string): string {
  return expressPath.replace(/:(\w+)/g, '{$1}');
}

// ── Schema helpers ──────────────────────────────────────────────────────

/**
 * Create a JSON Schema `$ref` pointing to `#/components/schemas/<name>`.
 */
function schemaRef(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

/**
 * Map JSDoc type strings to JSON Schema types.
 */
function toJsonSchemaType(type: string): string {
  switch (type.toLowerCase()) {
    case 'number':
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

// ── Operation builder ───────────────────────────────────────────────────

/**
 * Build a single OpenAPI operation object from an annotated route.
 */
export function buildOperation(
  route: RouteDefinition,
  annotation: ParsedAnnotation,
): Record<string, unknown> {
  const operation: Record<string, unknown> = {};

  if (route.operationId) operation.operationId = route.operationId;
  if (route.tags?.length) operation.tags = route.tags;
  if (annotation.summary) operation.summary = annotation.summary;
  if (annotation.description) operation.description = annotation.description;

  // Parameters
  if (annotation.params.length > 0) {
    operation.parameters = annotation.params.map((p) => ({
      name: p.name,
      in: p.location,
      required: p.required,
      description: p.description,
      schema: { type: toJsonSchemaType(p.type) },
    }));
  }

  // Request body
  if (annotation.body) {
    operation.requestBody = {
      description: annotation.body.description,
      required: true,
      content: {
        'application/json': {
          schema: schemaRef(annotation.body.schema),
        },
      },
    };
  }

  // Responses
  if (annotation.responses.length > 0) {
    const responses: Record<string, unknown> = {};
    for (const r of annotation.responses) {
      const responseObj: Record<string, unknown> = {
        description: r.description,
      };
      if (r.schema) {
        responseObj.content = {
          'application/json': {
            schema: schemaRef(r.schema),
          },
        };
      }
      responses[r.statusCode] = responseObj;
    }
    operation.responses = responses;
  } else {
    // OpenAPI requires at least one response
    operation.responses = {
      '200': { description: 'Success' },
    };
  }

  return operation;
}

// ── Spec generator ──────────────────────────────────────────────────────

/**
 * Collect all unique schema names referenced in annotations and create
 * placeholder component schemas.
 */
function collectSchemas(routes: AnnotatedRoute[]): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};

  for (const { annotation } of routes) {
    for (const r of annotation.responses) {
      if (r.schema) {
        schemas[r.schema] = {
          type: 'object',
          description: `${r.schema} schema (auto-generated placeholder)`,
        };
      }
    }
    if (annotation.body) {
      schemas[annotation.body.schema] = {
        type: 'object',
        description: `${annotation.body.schema} schema (auto-generated placeholder)`,
      };
    }
  }

  return schemas;
}

/**
 * Generate a complete OpenAPI 3.0.3 specification from annotated routes.
 */
export function generateSpec(
  routes: AnnotatedRoute[],
  options: OpenAPIGeneratorOptions,
): OpenAPISpec {
  const spec: OpenAPISpec = {
    openapi: '3.0.3',
    info: {
      title: options.title,
      version: options.version,
    },
    paths: {},
    components: {
      schemas: collectSchemas(routes),
    },
  };

  if (options.description) {
    spec.info.description = options.description;
  }

  if (options.serverUrl) {
    spec.servers = [{ url: options.serverUrl }];
  }

  // Group operations by path
  for (const { route, annotation } of routes) {
    const openApiPath = toOpenAPIPath(route.path);

    if (!spec.paths[openApiPath]) {
      spec.paths[openApiPath] = {};
    }

    (spec.paths[openApiPath] as Record<string, unknown>)[route.method] =
      buildOperation(route, annotation);
  }

  return spec;
}

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Perform basic validation on a generated OpenAPI spec.
 * Returns an array of error messages (empty if valid).
 */
export function validateSpec(spec: OpenAPISpec): string[] {
  const errors: string[] = [];

  if (spec.openapi !== '3.0.3') {
    errors.push(`Invalid openapi version: expected '3.0.3', got '${spec.openapi}'`);
  }

  if (!spec.info?.title) {
    errors.push('Missing info.title');
  }

  if (!spec.info?.version) {
    errors.push('Missing info.version');
  }

  if (!spec.paths || typeof spec.paths !== 'object') {
    errors.push('Missing or invalid paths object');
  }

  for (const [path, methods] of Object.entries(spec.paths)) {
    if (!path.startsWith('/')) {
      errors.push(`Path must start with '/': ${path}`);
    }

    for (const [method, operation] of Object.entries(methods as Record<string, unknown>)) {
      const validMethods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
      if (!validMethods.includes(method)) {
        errors.push(`Invalid HTTP method '${method}' on path '${path}'`);
      }

      const op = operation as Record<string, unknown>;
      if (!op.responses || typeof op.responses !== 'object') {
        errors.push(`Operation ${method.toUpperCase()} ${path} missing responses`);
      }
    }
  }

  return errors;
}
