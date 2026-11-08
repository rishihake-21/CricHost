# Realtime gateway

The realtime process provides public tournament-auction and match updates over Server-Sent Events (SSE). It consumes the API worker's at-least-once Redis publication channel (`crichost:domain-events:v1`), accepts only `PUBLIC` allowlisted events, rechecks that the tournament remains public (and that a match still exists), and projects each event into an explicit public DTO. Tenant IDs, player identities, scorer data, bidder identities, purse balances, and arbitrary outbox data are never forwarded.

## Local run

Set `MONGODB_URI`, `REDIS_URL`, `WEB_ORIGINS`, and `API_PUBLIC_BASE_URL` (the public HTTP API origin; defaults to `http://localhost:4000`), plus optionally `REALTIME_PORT`, `REALTIME_MAX_STREAMS`, `REALTIME_MAX_STREAMS_PER_IP`, and `TRUST_PROXY_HOPS` in `.env`, then run `pnpm realtime`. The API and outbox worker must also be running. Readiness is exposed at `/health/ready`; liveness is exposed at `/health/live`.

## Public auction stream

Connect to `GET /public/v1/tournaments/{tournamentId}/auction/events`. The gateway admits streams only for a public tournament with a visible auction. A new stream emits `snapshot_required` with an absolute `snapshotUrl` built from `API_PUBLIC_BASE_URL`; clients should fetch the public auction snapshot before applying events. Reconnects also begin with a snapshot notice. Redis disconnect/reconnect and gateway shutdown emit the same notice. Redis Pub/Sub does not replay history, so clients must recover state from the snapshot and use event IDs and aggregate versions to deduplicate and detect gaps. The stream is advisory; the HTTP snapshot/results endpoints remain the source of truth.

Event names are `auction.scheduled`, `auction.started`, `auction.paused`, `auction.resumed`, `auction.lot.opened`, `auction.lot.reoffered`, `auction.bid.accepted`, `auction.lot.sold`, `auction.lot.unsold`, and `auction.completed`. Each `data` object contains only the fields defined in `apps/realtime/src/main.ts`. Sensitive or unknown fields are removed by projection. Responses disable caching and proxy buffering and send a 15-second heartbeat.

The stream connection rate and concurrent-stream caps are process-local. Multiple gateway replicas therefore need a shared connection/rate-limit strategy and sticky or event-bus-aware operations before high-volume deployment. Authenticated Socket.IO rooms are not implemented yet; when added, each room join must be authorized against the principal, tenant, resource assignment, and current membership.

## Public match stream

Connect to `GET /public/v1/tournaments/{tournamentId}/matches/{matchId}/events`. The gateway admits streams only for an existing match in a public tournament. A new stream emits `snapshot_required` with the public HTTP score snapshot URL; reconnects and transport recovery do the same because Redis Pub/Sub does not replay events. `match.snapshot.changed` includes only match and tournament IDs in its public data. Clients use it as a version notice, fetch the score snapshot, and deduplicate notices with the SSE event ID and aggregate version. Public match snapshots omit player identities and scorer details.
