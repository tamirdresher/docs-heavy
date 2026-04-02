/**
 * JSDoc annotation parser for OpenAPI metadata.
 *
 * Reads TypeScript source files and extracts @openapi-annotated JSDoc
 * blocks, then parses @summary, @description, @param, @response, and
 * @body tags into structured data.
 */

import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type {
  ParsedAnnotation,
  ParsedParam,
  ParsedResponse,
  ParsedBody,
  ParamLocation,
  RouteDefinition,
} from './types.js';

// ── JSDoc block extraction ──────────────────────────────────────────────

/**
 * Extract all JSDoc comment blocks from source text.
 * Returns an array of raw comment strings (without delimiters).
 */
export function extractJSDocBlocks(source: string): string[] {
  const pattern = /\/\*\*([\s\S]*?)\*\//g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

/**
 * Returns true when a JSDoc block contains the @openapi tag.
 */
export function isOpenAPIBlock(block: string): boolean {
  return /@openapi\b/.test(block);
}

// ── Tag parsers ─────────────────────────────────────────────────────────

/**
 * Parse the @summary tag from a JSDoc block.
 */
export function parseSummary(block: string): string {
  const match = block.match(/@summary\s+(.+)/);
  return match ? match[1].trim() : '';
}

/**
 * Parse the @description tag from a JSDoc block.
 * Falls back to the first non-tag line if no explicit @description is present.
 */
export function parseDescription(block: string): string {
  const match = block.match(/@description\s+(.+)/);
  if (match) return match[1].trim();

  // Fallback: first line of the block that isn't a tag
  const lines = block.split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim());
  for (const line of lines) {
    if (line && !line.startsWith('@')) return line;
  }
  return '';
}

/**
 * Parse all @param tags.
 *
 * Supported format:
 *   @param {type} name - Description (location)
 *
 * Location defaults to 'query' when not specified.
 */
export function parseParams(block: string): ParsedParam[] {
  const pattern = /@param\s+\{(\w+)\}\s+(\w+)\s*-\s*(.+)/g;
  const params: ParsedParam[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(block)) !== null) {
    const type = match[1];
    const name = match[2];
    const rest = match[3].trim();

    // Extract location from parentheses at the end
    const locMatch = rest.match(/\((\w+)\)\s*$/);
    const location: ParamLocation =
      locMatch && isValidLocation(locMatch[1]) ? (locMatch[1] as ParamLocation) : 'query';

    const description = locMatch ? rest.replace(/\(\w+\)\s*$/, '').trim() : rest;

    params.push({
      name,
      type,
      description,
      location,
      required: location === 'path',
    });
  }

  return params;
}

function isValidLocation(loc: string): loc is ParamLocation {
  return ['path', 'query', 'header'].includes(loc);
}

/**
 * Parse all @response tags.
 *
 * Supported formats:
 *   @response 200 { SchemaName } - Description
 *   @response 204 - Description  (no schema)
 */
export function parseResponses(block: string): ParsedResponse[] {
  const pattern = /@response\s+(\d{3})\s+(?:\{\s*(\w+)\s*\}\s*-\s*)?(.+)/g;
  const responses: ParsedResponse[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(block)) !== null) {
    const statusCode = match[1];
    const schema = match[2] || null;
    let description = match[3].trim();

    // Handle the case where description starts with "- "
    if (description.startsWith('- ')) {
      description = description.slice(2).trim();
    }

    responses.push({ statusCode, schema, description });
  }

  return responses;
}

/**
 * Parse the @body tag.
 *
 * Format: @body { SchemaName } - Description
 */
export function parseBody(block: string): ParsedBody | null {
  const match = block.match(/@body\s+\{\s*(\w+)\s*\}\s*-\s*(.+)/);
  if (!match) return null;

  return {
    schema: match[1],
    description: match[2].trim(),
  };
}

// ── Full annotation parser ──────────────────────────────────────────────

/**
 * Parse a single @openapi JSDoc block into structured annotation data.
 */
export function parseAnnotation(block: string): ParsedAnnotation {
  return {
    summary: parseSummary(block),
    description: parseDescription(block),
    params: parseParams(block),
    responses: parseResponses(block),
    body: parseBody(block),
  };
}

// ── Route file scanning ─────────────────────────────────────────────────

/**
 * Find all .ts route files in the given directory (non-recursive).
 * Excludes index.ts to avoid duplicating re-exported definitions.
 */
export async function findRouteFiles(routesDir: string): Promise<string[]> {
  const entries = await readdir(routesDir);
  return entries
    .filter((f) => extname(f) === '.ts' && f !== 'index.ts')
    .sort()
    .map((f) => join(routesDir, f));
}

/**
 * Represents a matched pair: a JSDoc annotation block + its route definition export.
 */
export interface AnnotatedRoute {
  annotation: ParsedAnnotation;
  route: RouteDefinition;
}

/**
 * Parse a source file and return all annotated route pairs.
 *
 * Matching strategy: each @openapi JSDoc block is paired with the
 * immediately following exported RouteDefinition object literal.
 */
export function parseRouteFile(filePath: string): AnnotatedRoute[] {
  const source = readFileSync(filePath, 'utf-8');
  return parseRouteSource(source);
}

/**
 * Parse route source text and return annotated route pairs.
 */
export function parseRouteSource(source: string): AnnotatedRoute[] {
  const results: AnnotatedRoute[] = [];

  // Find all @openapi JSDoc blocks and the RouteDefinition that follows
  const blockPattern = /\/\*\*([\s\S]*?)\*\/\s*export\s+(?:const|let)\s+\w+\s*:\s*RouteDefinition\s*=\s*(\{[\s\S]*?\});/g;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(source)) !== null) {
    const block = match[1];
    if (!isOpenAPIBlock(block)) continue;

    const annotation = parseAnnotation(block);

    // Parse the route definition object literal
    const routeObj = match[2];
    const route = parseRouteObject(routeObj);
    if (route) {
      results.push({ annotation, route });
    }
  }

  return results;
}

/**
 * Parse a RouteDefinition object literal string into a typed object.
 */
function parseRouteObject(objStr: string): RouteDefinition | null {
  const method = extractStringProp(objStr, 'method');
  const path = extractStringProp(objStr, 'path');
  const operationId = extractStringProp(objStr, 'operationId');

  if (!method || !path || !operationId) return null;

  const tagsMatch = objStr.match(/tags:\s*\[([^\]]*)\]/);
  const tags = tagsMatch
    ? tagsMatch[1]
        .split(',')
        .map((t) => t.trim().replace(/['"]/g, ''))
        .filter(Boolean)
    : undefined;

  return {
    method: method as RouteDefinition['method'],
    path,
    operationId,
    tags,
  };
}

function extractStringProp(objStr: string, prop: string): string | null {
  const pattern = new RegExp(`${prop}:\\s*['"]([^'"]+)['"]`);
  const match = objStr.match(pattern);
  return match ? match[1] : null;
}
