# Background workers

The API workspace provides two separate worker entrypoints:

- `pnpm worker` publishes transactional outbox events. It claims durable events from MongoDB, publishes schema-versioned envelopes to the Redis pub/sub channel `crichost:domain-events:v1`, then marks them published. Retries are bounded; delivery is at least once, so realtime consumers must deduplicate by `eventId` and recover from snapshots. Redis pub/sub is an ephemeral fan-out transport, not the durable event store.
- `pnpm auction-worker` polls for expired current lots and live auctions without an open lot. It transactionally finalizes the expired result, applies sold roster/purse effects, and opens the next lot or completes the auction. It uses MongoDB only and can run independently of Redis and the outbox publisher. Set `AUCTION_TIMER_POLL_MS` to tune its polling interval (100–60000 ms; default 1000 ms).

The outbox worker emits `outbox_worker_heartbeat` JSON records with pending/processing/dead counts, expired leases, oldest queue ages and successful publishes/retries since the previous heartbeat. An increase in the dead-letter count emits `outbox_dead_letter_backlog`. Configure `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_HEARTBEAT_INTERVAL_MS`, `OUTBOX_LEASE_SECONDS` and `OUTBOX_MAX_ATTEMPTS`; production log collection should alert on the dead-letter event and track oldest pending age against the approved service objective.

Auction workers can run as multiple replicas: transactions, lot versions, and unique result-per-attempt constraints make duplicate scans safe. Settlement invariant failures are logged with auction/lot IDs and retried on later scans; operators should investigate persistent failures. The timer poll interval bounds normal finalization delay, not the time required to resolve database or invariant errors.

Future job families include notifications, exports, scoring projection reconciliation, scheduled state transitions and retention tasks. Notification recipients, channel preferences, delivery consent and email provider are not defined yet; domain events are not automatically sent as messages.
