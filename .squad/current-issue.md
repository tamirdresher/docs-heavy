# Add OpenAPI spec generation from route definitions

## Feature Request

**Summary**
Add automatic OpenAPI 3.0 spec generation from the existing route definitions. Developers should be able to add JSDoc-like annotations to routes and get a valid OpenAPI spec at `/api/docs/openapi.json`.

**Requirements**
1. Parse route files in `src/routes/` to extract path, method, params
2. Support annotations via JSDoc comments or decorators
3. Generate valid OpenAPI 3.0.3 JSON
4. Serve at `GET /api/docs/openapi.json`
5. Include request/response schemas from TypeScript types
6. Swagger UI at `GET /api/docs`

**Example annotation**
```typescript
/**
 * @openapi
 * @summary Get product by ID
 * @param {string} id - Product ID
 * @response 200 { Product } - Success
 * @response 404 { Error } - Not found
 */
router.get('/products/:id', getProduct);
```

**Acceptance Criteria**
- [ ] Valid OpenAPI 3.0.3 spec generated
- [ ] All existing routes included in spec
- [ ] Swagger UI accessible at /api/docs
- [ ] Spec updates automatically when routes change (no build step)
- [ ] Tests validate spec structure