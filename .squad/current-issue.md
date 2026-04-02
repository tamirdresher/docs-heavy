# Implement webhook retry with exponential backoff

## Feature Request

**Summary**
Implement webhook delivery with retry logic. Failed deliveries should be retried with exponential backoff, and permanently failed webhooks should be moved to a dead-letter queue.

**Requirements**
1. Retry up to 5 times on HTTP 5xx or network error
2. Exponential backoff: 1s, 2s, 4s, 8s, 16s (base 2, no jitter initially)
3. Configurable max retries and base delay
4. Dead-letter queue for messages that exhaust retries
5. Webhook payload includes: `event`, `timestamp`, `attempt`, `webhookId`
6. Delivery status tracking: pending, retrying, delivered, failed

**Data Model**
```typescript
interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payload: unknown;
  status: 'pending' | 'retrying' | 'delivered' | 'failed';
  attempts: number;
  nextRetryAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}
```

**Acceptance Criteria**
- [ ] Successful delivery on first attempt (no retry)
- [ ] Retries on 5xx with exponential backoff
- [ ] Moves to dead-letter after max retries
- [ ] Status tracking is accurate
- [ ] Unit tests for retry logic and backoff calculation