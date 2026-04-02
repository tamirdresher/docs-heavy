/**
 * Public API for the OpenAPI spec generator.
 *
 * Usage:
 * ```ts
 * import { buildOpenAPISpec } from './openapi/index.js';
 *
 * const spec = await buildOpenAPISpec('./src/routes', {
 *   title: 'My API',
 *   version: '1.0.0',
 * });
 * console.log(JSON.stringify(spec, null, 2));
 * ```
 */

export { generateSpec, validateSpec, toOpenAPIPath, buildOperation } from './generator.js';
export {
  extractJSDocBlocks,
  isOpenAPIBlock,
  parseSummary,
  parseDescription,
  parseParams,
  parseResponses,
  parseBody,
  parseAnnotation,
  parseRouteFile,
  parseRouteSource,
  findRouteFiles,
} from './parser.js';
export type {
  RouteDefinition,
  OpenAPISpec,
  OpenAPIGeneratorOptions,
  ParsedAnnotation,
  ParsedParam,
  ParsedResponse,
  ParsedBody,
  HttpMethod,
  ParamLocation,
} from './types.js';
export type { AnnotatedRoute } from './parser.js';

import { findRouteFiles, parseRouteFile } from './parser.js';
import { generateSpec, validateSpec } from './generator.js';
import type { OpenAPIGeneratorOptions, OpenAPISpec } from './types.js';

/**
 * High-level convenience: scan a routes directory and generate a full
 * OpenAPI 3.0.3 spec.
 *
 * @throws if the generated spec fails validation
 */
export async function buildOpenAPISpec(
  routesDir: string,
  options: OpenAPIGeneratorOptions,
): Promise<OpenAPISpec> {
  const files = await findRouteFiles(routesDir);
  const allRoutes = files.flatMap((f) => parseRouteFile(f));

  const spec = generateSpec(allRoutes, options);

  const errors = validateSpec(spec);
  if (errors.length > 0) {
    throw new Error(`Generated spec is invalid:\n${errors.join('\n')}`);
  }

  return spec;
}
