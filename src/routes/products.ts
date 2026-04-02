/**
 * Product routes.
 *
 * CRUD operations for managing products in the catalog.
 */

import type { RouteDefinition } from '../openapi/types.js';

/**
 * @openapi
 * @summary List all products
 * @description Retrieve a paginated list of products. Supports filtering by category and sorting.
 * @param {number} page - Page number (query)
 * @param {number} limit - Items per page (query)
 * @param {string} category - Filter by category (query)
 * @response 200 { ProductList } - A paginated list of products
 */
export const listProducts: RouteDefinition = {
  method: 'get',
  path: '/api/products',
  operationId: 'listProducts',
  tags: ['Products'],
};

/**
 * @openapi
 * @summary Get product by ID
 * @description Retrieve a single product by its unique identifier.
 * @param {string} id - Product ID (path)
 * @response 200 { Product } - The requested product
 * @response 404 { Error } - Product not found
 */
export const getProduct: RouteDefinition = {
  method: 'get',
  path: '/api/products/:id',
  operationId: 'getProduct',
  tags: ['Products'],
};

/**
 * @openapi
 * @summary Create a product
 * @description Add a new product to the catalog.
 * @body { CreateProductRequest } - Product data
 * @response 201 { Product } - The created product
 * @response 400 { Error } - Validation error
 */
export const createProduct: RouteDefinition = {
  method: 'post',
  path: '/api/products',
  operationId: 'createProduct',
  tags: ['Products'],
};

/**
 * @openapi
 * @summary Update a product
 * @description Update an existing product by ID.
 * @param {string} id - Product ID (path)
 * @body { UpdateProductRequest } - Updated product data
 * @response 200 { Product } - The updated product
 * @response 404 { Error } - Product not found
 */
export const updateProduct: RouteDefinition = {
  method: 'put',
  path: '/api/products/:id',
  operationId: 'updateProduct',
  tags: ['Products'],
};

/**
 * @openapi
 * @summary Delete a product
 * @description Remove a product from the catalog.
 * @param {string} id - Product ID (path)
 * @response 204 - Product deleted
 * @response 404 { Error } - Product not found
 */
export const deleteProduct: RouteDefinition = {
  method: 'delete',
  path: '/api/products/:id',
  operationId: 'deleteProduct',
  tags: ['Products'],
};
