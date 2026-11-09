# Outbox worker and dead-letter response

**Owner:** On-call platform engineer

**Trigger:** `outbox_redis_error`, sustained growth in pending queue age, `outbox_dead_letter_backlog`, or `outbox_event_dead_lettered` logs.

**Impact:** Durable domain events remain in MongoDB, but realtime consumers may receive them late or more than once. Notifications and other future consumers must not depend on Redis pub/sub as their source of truth.

## Diagnosis

1. Check `outbox_worker_heartbeat` for pending, processing, expired lease and dead-letter counts, `oldestPendingAgeMs`, and publish/retry totals.
2. Check `outbox_redis_error` and `outbox_publish_retry_scheduled` logs, then verify Redis availability and the configured `REDIS_URL` from the worker runtime.
3. Inspect dead-letter records without changing them:

   ```javascript
   db.outbox_events.find(
     { status: "DEAD" },
     { eventId: 1, eventType: 1, tenantId: 1, aggregateType: 1, aggregateId: 1, attempts: 1, lastErrorCode: 1, createdAt: 1 }
   ).sort({ createdAt: 1 }).limit(100)
   ```

4. Check `outbox_worker_started` and `outbox_worker_stopped` logs to confirm worker lifecycle and replica count.

Production disables Mongoose automatic index creation. Before rolling out this worker version, apply the additive `outbox_status_created` index using the approved database index change process:

```javascript
db.outbox_events.createIndex({ status: 1, createdAt: 1 }, { name: "outbox_status_created" })
```

## Mitigation and recovery

1. Restore Redis connectivity or correct the worker configuration. The worker retries pending events with bounded exponential backoff and jitter.
2. If pending queue age continues to rise after Redis recovers, confirm the worker can connect to MongoDB and Redis and that its process is running. Adjust `OUTBOX_POLL_INTERVAL_MS` only after checking database and Redis capacity.
3. Dead-letter events remain durable. The internal `requeueDeadOutboxEvent` service operation resets the delivery attempt count, increments a replay counter and records an audit entry with the operator reason. It has no HTTP or CLI surface and must not be invoked until a caller enforces platform-admin authorization/MFA. Preserve the records and escalate until that control path is available. Do not edit status or attempt fields directly in MongoDB.

## Verification and escalation

Confirm that pending queue age returns to normal for the approved service objective, expired leases stop accumulating, and new dead-letter counts remain zero. Realtime consumers should recover from their authoritative snapshots and deduplicate by `eventId` because delivery is at least once.

Escalate persistent dead letters, suspected duplicate side effects, or event payload/privacy concerns to the platform engineering owner. External paging and service objectives are deployment decisions and are not configured by this repository yet.
