/**
 * Shared types for the OpenAPI spec generator.
 */

/** HTTP methods supported in route definitions. */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Where a parameter is located. */
export type ParamLocation = 'path' | 'query' | 'header';

/** A single route definition that the generator consumes. */
export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  operationId: string;
  tags?: string[];
}

/** A parsed parameter from JSDoc annotations. */
export interface ParsedParam {
  name: string;
  type: string;
  description: string;
  location: ParamLocation;
  required: boolean;
}

/** A parsed response from JSDoc annotations. */
export interface ParsedResponse {
  statusCode: string;
  schema: string | null;
  description: string;
}

/** A parsed request body from JSDoc annotations. */
export interface ParsedBody {
  schema: string;
  description: string;
}

/** Annotation data extracted from a JSDoc block. */
export interface ParsedAnnotation {
  summary: string;
  description: string;
  params: ParsedParam[];
  responses: ParsedResponse[];
  body: ParsedBody | null;
}

/** Options for the OpenAPI generator. */
export interface OpenAPIGeneratorOptions {
  /** API title shown in the spec info section. */
  title: string;
  /** API version (semver). */
  version: string;
  /** Optional description for the API. */
  description?: string;
  /** Base server URL. */
  serverUrl?: string;
}

/** OpenAPI 3.0.3 top-level document. */
export interface OpenAPISpec {
  openapi: '3.0.3';
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
  };
}
