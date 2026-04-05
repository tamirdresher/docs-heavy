/**
 * Webhook delivery with retry logic and exponential backoff.
 *
 * Retries failed deliveries (HTTP 5xx / network errors) with exponential
 * backoff and moves permanently failed webhooks to a dead-letter queue.
 *
 * Usage:
 * ```ts
 * const manager = new WebhookDeliveryManager({
 *   maxRetries: 5,
 *   baseDelayMs: 1000,
 *   deliverFn: async (url, payload) => {
 *     const res = await fetch(url, { method: 'POST', body: JSON.stringify(payload) });
 *     return { statusCode: res.status };
 *   },
 * });
 *
 * await manager.deliver({
 *   url: 'https://example.com/webhook',
 *   event: 'order.created',
 *   payload: { orderId: '123' },
 *   webhookId: 'wh_abc',
 * });
 * ```
 */

// ── Data model ──────────────────────────────────────────────────────────

export type DeliveryStatus = 'pending' | 'retrying' | 'delivered' | 'failed';

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payload: unknown;
  status: DeliveryStatus;
  attempts: number;
  nextRetryAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

// ── Configuration ───────────────────────────────────────────────────────

export interface WebhookRetryOptions {
  /** Maximum number of retry attempts. Must be ≥ 0. Defaults to 5. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Must be > 0. Defaults to 1000. */
  baseDelayMs?: number;
  /**
   * Function that performs the actual HTTP delivery.
   * Must return an object with at least `statusCode`.
   * Throwing is treated as a network error.
   */
  deliverFn: (url: string, payload: DeliveryPayload) => Promise<DeliveryResult>;
  /** Optional function to generate unique IDs. Defaults to a simple counter. */
  idGenerator?: () => string;
}

export interface DeliveryPayload {
  event: string;
  timestamp: string;
  attempt: number;
  webhookId: string;
  data: unknown;
}

export interface DeliveryResult {
  statusCode: number;
}

export interface DeliverRequest {
  url: string;
  event: string;
  payload: unknown;
  webhookId: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Calculate the backoff delay for a given attempt (0-indexed).
 *
 * Formula: `baseDelayMs * 2^attempt`
 * Example with baseDelayMs=1000: 1s, 2s, 4s, 8s, 16s
 */
export function calculateBackoff(attempt: number, baseDelayMs: number): number {
  if (attempt < 0 || !Number.isFinite(attempt) || !Number.isInteger(attempt)) {
    throw new Error('attempt must be a non-negative integer');
  }
  if (baseDelayMs <= 0 || !Number.isFinite(baseDelayMs)) {
    throw new Error('baseDelayMs must be a positive finite number');
  }
  return baseDelayMs * Math.pow(2, attempt);
}

/**
 * Returns true when the HTTP status code indicates a server error
 * that should be retried.
 */
export function isRetryableStatus(statusCode: number): boolean {
  return statusCode >= 500 && statusCode <= 599;
}

let _counter = 0;
function defaultIdGenerator(): string {
  return `del_${++_counter}_${Date.now()}`;
}

// ── Validation ──────────────────────────────────────────────────────────

function validateOptions(opts: WebhookRetryOptions): void {
  const maxRetries = opts.maxRetries ?? 5;
  if (typeof maxRetries !== 'number' || maxRetries < 0 || !Number.isInteger(maxRetries)) {
    throw new Error('maxRetries must be a non-negative integer');
  }

  const baseDelayMs = opts.baseDelayMs ?? 1000;
  if (typeof baseDelayMs !== 'number' || baseDelayMs <= 0 || !Number.isFinite(baseDelayMs)) {
    throw new Error('baseDelayMs must be a positive finite number');
  }

  if (typeof opts.deliverFn !== 'function') {
    throw new Error('deliverFn must be a function');
  }

  if (opts.idGenerator !== undefined && typeof opts.idGenerator !== 'function') {
    throw new Error('idGenerator must be a function');
  }
}

// ── Manager ─────────────────────────────────────────────────────────────

export class WebhookDeliveryManager {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly deliverFn: WebhookRetryOptions['deliverFn'];
  private readonly idGenerator: () => string;

  /** All tracked deliveries. */
  private readonly deliveries = new Map<string, WebhookDelivery>();
  /** Dead-letter queue for deliveries that exhausted retries. */
  private readonly deadLetterQueue: WebhookDelivery[] = [];

  constructor(options: WebhookRetryOptions) {
    validateOptions(options);
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.deliverFn = options.deliverFn;
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
  }

  /**
   * Attempt to deliver a webhook. On failure, retries with exponential
   * backoff up to `maxRetries` times. If all retries are exhausted the
   * delivery is moved to the dead-letter queue.
   *
   * Returns the final WebhookDelivery record.
   */
  async deliver(request: DeliverRequest): Promise<WebhookDelivery> {
    const delivery: WebhookDelivery = {
      id: this.idGenerator(),
      webhookId: request.webhookId,
      event: request.event,
      payload: request.payload,
      status: 'pending',
      attempts: 0,
      nextRetryAt: null,
      lastError: null,
      createdAt: new Date(),
      deliveredAt: null,
    };

    this.deliveries.set(delivery.id, delivery);

    return this.attemptDelivery(delivery, request.url);
  }

  /** Retrieve a delivery by ID. */
  getDelivery(id: string): WebhookDelivery | undefined {
    return this.deliveries.get(id);
  }

  /** Return a snapshot of the dead-letter queue. */
  getDeadLetterQueue(): ReadonlyArray<WebhookDelivery> {
    return [...this.deadLetterQueue];
  }

  // ── internal ────────────────────────────────────────────────────────

  private async attemptDelivery(
    delivery: WebhookDelivery,
    url: string,
  ): Promise<WebhookDelivery> {
    // Total allowed attempts = 1 (initial) + maxRetries
    const maxAttempts = 1 + this.maxRetries;

    while (delivery.attempts < maxAttempts) {
      delivery.attempts++;

      // Wait for backoff on retries (attempt index is 0-based for backoff)
      if (delivery.attempts > 1) {
        delivery.status = 'retrying';
        const backoffMs = calculateBackoff(delivery.attempts - 2, this.baseDelayMs);
        delivery.nextRetryAt = new Date(Date.now() + backoffMs);
        await this.sleep(backoffMs);
      }

      const payload: DeliveryPayload = {
        event: delivery.event,
        timestamp: new Date().toISOString(),
        attempt: delivery.attempts,
        webhookId: delivery.webhookId,
        data: delivery.payload,
      };

      try {
        const result = await this.deliverFn(url, payload);

        if (!isRetryableStatus(result.statusCode)) {
          // Success (or a non-retryable client error)
          delivery.status = 'delivered';
          delivery.deliveredAt = new Date();
          delivery.nextRetryAt = null;
          delivery.lastError = null;
          return delivery;
        }

        // Server error — record and loop for retry
        delivery.lastError = `HTTP ${result.statusCode}`;
      } catch (err: unknown) {
        // Network error — record and loop for retry
        delivery.lastError =
          err instanceof Error ? err.message : String(err);
      }
    }

    // All attempts exhausted → dead-letter
    delivery.status = 'failed';
    delivery.nextRetryAt = null;
    this.deadLetterQueue.push(delivery);
    return delivery;
  }

  /** Overridable sleep for testability. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
