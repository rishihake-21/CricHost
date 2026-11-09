# Usage

Tenant owners/admins can read a private usage snapshot for active tournaments, active members plus pending invitations, per-tournament team/registration/campaign counts, and reserved/used asset bytes. The snapshot also shows recorded monthly counters and configured plan limits. API request, export, realtime connection and public audience dimensions are not fully instrumented.

`recordUsageEvent` writes an idempotency-keyed usage event and increments its period counter in the caller's transaction. Events are append-only by service convention and sensitive fields are excluded from dimensions. Resource quota checks read authoritative domain counts and serialize consumption through the tenant subscription guard document.

Metric definitions, event deduplication sources, retention, consent, warning/grace behavior and customer billing reports require product decisions. No usage values are used to bill customers in this slice.
