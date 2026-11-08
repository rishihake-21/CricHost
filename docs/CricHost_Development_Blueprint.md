# CricHost Development Blueprint

## Product requirements, system design, delivery plan and operating model

Version 1.0 | 08 November 2026  
Prepared for product, engineering, quality, security and operations teams

## Purpose and recommendation

This blueprint consolidates the supplied CricHost SaaS Development Specification and Software Low-Level Design into an implementation reference. It defines product behavior, business invariants, proposed technical structure, rollout gates and the non-technical operating decisions needed for launch. The repository scaffold is a foundation only: workflows and controls in this document are requirements, not claims of completed implementation.

Build CricHost as a multi-tenant cricket operations SaaS with a responsive public portal and authenticated workspaces. Start with a TypeScript monorepo and a modular monolith deployed as separate API, realtime and worker processes. Prioritize tenant isolation, identity, tournament, player and team foundations before auction and scoring. Accepted bids and deliveries must be durable, auditable commands; realtime channels distribute committed state. Approve Gate 0 decisions before production-facing implementation.

The supplied target is 5,000 concurrent public spectators and 10–50 scorers. These are test targets, not proven capacity. Test auction contention separately.

## 1. Source alignment, status and scope

Reviewed `CricHost_SaaS_Development_Specification.docx` v1.0 and `CricHost_Software_Low_Level_Design_v1.docx`. The workspace contained no application source beyond Git metadata. This is therefore a clean foundation, not a code migration or verification of any existing implementation.

Both sources align on product boundaries, modular monolith, tenant-scoped permissions, auditable auctions, append-oriented scoring, outbox delivery and recovery. The SaaS specification gives product scope and requirements; the LLD gives deeper transaction, concurrency and runtime design. When a choice is unresolved, this blueprint preserves it as an ADR rather than silently declaring it final.

### Product outcomes

- Organizations operate multiple tournaments, members, teams, registrations, auctions, fixtures, matches, sponsors and reports.
- Players maintain reusable profiles independent of teams, then apply to individual tournament seasons.
- Organizers can operate optional, auditable auctions with configured virtual purses and roster constraints.
- Sold players receive tournament-specific roster participation rights; a person/account is never owned by a team.
- Support T10, T20, ODI, Test and custom formats, plus knockout, round-robin and group-to-knockout structures.
- Scorers record ball-by-ball events with recovery, corrections and public live updates.
- Platform operators can manage plans, quotas, abuse and tenant support.

### Release 1 non-goals

No real-money wallet, betting, wagering or spectator prediction market. The purse is an internal roster budget. No automated player remuneration or contract settlement. No microservices decomposition at launch. Responsive web is the baseline; native mobile apps are not required. Direct registration remains available without auction. Any later payment or compensation feature needs separate financial, product, legal and safeguarding review.

## 2. Users, roles and operating responsibilities

| Persona | Scope and limits |
|---|---|
| Platform Super Admin | Organization, plan, platform settings, abuse and system health. Privileged access is logged and MFA-protected. |
| Organization Owner | Organization, invitations, branding, billing and tenant resources; no cross-tenant access. |
| Tournament Admin | Tournament participants, rules, auction, schedule, sponsors and match operations within assigned scope. |
| Player | Own profile, consent, application, documents and auction history; cannot bid for self or edit verified statistics. |
| Team Owner / Manager | Assigned team, team staff and roster. |
| Team Bidder | Bid only for explicitly assigned team/auction; cannot modify purse or team configuration. |
| Auctioneer | Operate lot, timer, pause and finalization; cannot silently alter bid history. |
| Auction Auditor | Inspect bids, results and purse ledger; read-only by default. |
| Scorer | Operate assigned matches and request corrections under policy. |
| Sponsor Manager | Assigned sponsor profile, campaigns and permitted analytics. |
| Public Spectator | Read published data only. |

Use role templates plus resource attributes. A role describes allowed actions; memberships and assignments describe where. Every operation checks principal, tenant, permission, resource state and ownership on the server. Deny by default. Never trust tenantId, role, userId, purse or eligibility supplied in a request as authorization facts. Log permission changes, bidder assignments, auction controls, scoring corrections and access to sensitive records.

Non-technical owners must be assigned before launch: a product owner for scope and acceptance; auction operations reviewer; cricket rules reviewer; privacy/legal advisors for minors and retention; security lead; DevOps/reliability owner; customer support and tournament operations lead. Publish onboarding, admin and match-day guides, support hours, severity definitions, escalation route, customer change policy and live-event change freeze rules.

## 3. Product workflows

### Organization onboarding

1. Register and verify configured email/phone identity.
2. Create an organization or accept a scoped invitation.
3. Create tenant and owner membership atomically or through recoverable provisioning.
4. Configure organization name, slug, timezone, locale, logo and defaults.
5. Apply plan quotas and establish usage baseline.

### Tournament setup

Lifecycle: Draft → Registration Open → Registration Closed → Scheduled → Live → Completed → Archived. Each transition has permission, prerequisites, audit history and versioned rules. Freeze the applicable rules version into each auction and match.

Configure identity, season, organizer, venues and timezone; registration and event dates; format and innings; structure, groups, seeds and qualification; eligibility and document review; auction enablement, purse, lots and squad rules; toss, extras, powerplay, dismissal and tie behavior; and public/private visibility. Fixture generation must be deterministic from saved inputs and seed. Validate teams, byes, pairings, round dependencies, venue/time conflicts and overlaps. Once a match starts, schedule changes are versioned and audited, never silent rewrites.

### Player, team and roster

PlayerProfile is reusable person identity. PlayerTournamentRegistration stores season application, eligibility, verification and auction status. Keep exact date of birth, contact data, guardian information, identity evidence and internal notes private. Public profile fields are explicitly allowlisted: display name, image, short bio, coarse location and approved cricket profile. Verified statistics come from accepted match data or reviewed imports.

A roster entry is a tournament-scoped participation right and references its source (auction result or direct registration). Effective dates and changes are audited. Prevent conflicting active rosters unless an approved tournament rule allows them. Team identity, team ownership and bidder assignment are distinct concepts.

### Auction

1. Create auction and freeze the rules version; configure purse, base price, increments, lot timer, squads, categories, visibility, unsold policy and anti-sniping.
2. Add participating teams and create purse accounts; assign authorized bidders.
3. Open applications, verify eligibility, close registration and freeze approved pool.
4. Snapshot approved public fields, generate stable lot order and validate duplicate registrations and account readiness.
5. Open one lot. Server validates bidder scope, auction/lot state, server time, idempotency key, expected version, minimum increment, purse and remaining squad feasibility.
6. In one transaction conditionally update lot, append bid, adjust reservation, append purse ledger and outbox event. Acknowledge only after commit.
7. Finalize SOLD or UNSOLD idempotently. Sold result commits purse and creates one roster entry; retries cannot duplicate effects. Publish after commit.

A stale version returns conflict and current price/version; never silently rebase. Available purse plus reservations must not exceed budget, and roster feasibility must preserve minimum remaining slots/funds. Boundary races between bid and timer serialize against lot version. Corrections append reason and actor; never erase bid history.

### Match and scoring

Rulesets cover format-specific innings, legal deliveries, extras, dismissals, batter/bowler attribution, follow-on, ties and completion. Test cricket cannot be represented as only two innings. A delivery command has clientEventId, expected event head/version, lease epoch and normalized delivery details. Server validates state and rules, appends immutable event, updates rebuildable projection and outbox atomically, then acknowledges/publishes.

One active scorer lease per innings uses monotonic leaseEpoch. Takeover increments epoch. Events queued under a stale epoch go to conflict review, not silent merge. Client clock is not authoritative. Offline UI shows queued, acknowledged, rejected and needs-review states. Corrections refer to original events with reason, actor and revised interpretation. Rebuild projections from event history plus corrections and reconcile periodically.

### Sponsors, plans and usage

Campaigns attach to approved placements, validity windows, assets and reporting permissions. Plans may cap organizations, tournaments, members, teams, registrations, storage, requests, exports, sponsor inventory, operator/scorer sessions and audience features. Choose block/warn/grace/upgrade behavior at quota boundaries; no silent overage. Distinguish authenticated sessions, realtime connections and public spectator usage. Define usage metric, deduplication, retention, customer visibility, billing and renewal policy before sale.

## 4. Domain model and invariants

All tenant-owned records carry tenantId. Tenant-scoped repositories enforce isolation. Public responses are allowlisted DTOs, never persistence documents with fields hidden in the browser.

| Record | Purpose and invariant |
|---|---|
| User / Session | Global identity and revocable sessions; account is not a tenant role. |
| Tenant / Membership | Organization boundary and scoped membership. All access enforces tenant. |
| Tournament / RulesVersion | Lifecycle and immutable competition configuration referenced by live operations. |
| PlayerProfile / Registration | Person identity separated from season application and eligibility. |
| Team / RosterEntry | Team and effective participation right, with source reference and uniqueness constraints. |
| Auction / Lot / Bid | Serialized lot state and append-only accepted bid history; one leader per open lot. |
| PurseAccount / Ledger | Integer internal unit, reservation/commit entries, append-only ledger; never negative. No stored value. |
| AuctionResult | Idempotent sold/unsold finalization; one winner and at most one active roster effect. |
| Match / Innings / BallEvent | Ruleset-bound state and immutable accepted delivery history. |
| ScoringLease / Correction | Monotonic fencing epoch; corrections preserve original event and reason. |
| OutboxEvent / AuditLog | Publish committed events at least once; idempotent consumers; auditable sensitive changes. |
| Asset / UsageRecord | Tenant-scoped metadata, access policy, aggregation, retention and quota behavior. |

Auction state: DRAFT → REGISTRATION_OPEN → REGISTRATION_CLOSED → POOL_APPROVED → SCHEDULED → LIVE ↔ PAUSED → COMPLETED → ARCHIVED. Lot state: QUEUED → OPEN → SOLD or UNSOLD. Withdrawal/reopen requires audited correction. Score projection must equal deterministic replay of accepted events plus corrections. A stale lease epoch cannot append.

## 5. Architecture and project structure

Use a modular monolith organized by domain. Deploy HTTP API, realtime gateway and background worker as separate stateless processes. Do not extract microservices until measured operational or scaling boundaries justify it.

| Layer | Responsibility |
|---|---|
| Web | Public portal and scoped workspaces; typed API client, server cache and IndexedDB scoring outbox. |
| HTTP API | Authentication, validation, policy checks, domain commands/queries and public DTOs. |
| Realtime | Authorized private Socket.IO rooms; public SSE version notices; snapshot recovery. |
| Worker | Outbox publishing, auction timers, notifications, schedule jobs, exports, projection repair and retention. |
| MongoDB proposal | Durable source of truth and transactions; replica set needed if multi-document transactions chosen. ADR-001 is open. |
| Redis proposal | Cache, ephemeral pub/sub, coordination and possibly queue. Never authoritative state. Queue choice is open. |
| Object storage/CDN | Signed uploads, scanning/transformation, metadata, access controls and delivery. |

Repository map: `apps/web`; `apps/api/src/platform`, `shared` and `modules`; `apps/realtime`; `apps/worker`; `packages/contracts`; `packages/config`; `docs/adr`; `docs/openapi`; `docs/runbooks`; `infra`. Backend module pattern: schema, repository, service, policy, DTO, routes, domain events and migration/index definitions. Frontend features contain pages, components, hooks, API calls and feature state. Shared contracts must not expose database document shapes.

### API and event contracts

Tenant API uses `/v1`; tenant resources are tenant-scoped. Public reads use `/public/v1`. Use UTF-8 JSON, RFC 3339 UTC, stable enums/errors, requestId, bounded cursor pagination and ETag/version or If-Match on mutable resources. Use idempotency keys on retryable commands. OpenAPI 3.1 is contract authority and includes schemas, examples, security, errors and validation constraints.

Private rooms are opaque/server-named and authorized at join and reconnect, for example tenant/auction operators, team-private auction state and assigned match scorers. Clients cannot join arbitrary rooms. Event envelopes carry eventId, type, aggregateId/version, occurredAt, visibility and schema version. Outbox is durable; delivery is at least once. Socket.IO/Redis pub-sub is ephemeral. On version gap, fetch snapshot and resume from a known cursor. Do not promise exactly-once network delivery.

### Data and migrations

Use tenant-scoped compound indexes, uniqueness constraints for slugs and domain identities, explicit allowlisted sort/filter fields and bounded page sizes. Keep migration/index changes backward compatible: expand, deploy compatible code, backfill, then contract in a later release. Database/provider selection, pool settings and production connection limits are not decided until target topology and load tests exist.

## 6. Security, privacy and safeguarding

Use deny-by-default authorization at every protected read/write. Public DTOs must omit private contact, exact DOB, identity evidence, internal notes, team-private purse and private object keys. Use TLS, managed encryption at rest, least-privilege DB/cloud identities, managed secrets and rotation. Rate-limit by IP, identity, tenant and sensitive operation. Protect login/recovery, invitations, bids, scoring, exports and uploads against abuse.

Choose secure HttpOnly cookie sessions if topology supports CSRF protection; document alternative token/refresh threat model if not. Revoke sessions on logout and credential compromise. Validate all input on the server; allowlist sort/filter fields. Redact tokens, passwords, sensitive profile data and request bodies from logs. Uploads use short-lived signed URLs or controlled service, extension/MIME/signature checks, size limits, random object keys, scanning, image processing and metadata stripping where appropriate.

Because minors may register, obtain jurisdiction-specific privacy/legal review before collecting age, identity or guardian information. Define age gating, guardian permissions, safe profile defaults, consent, retention, deletion/export and legal hold. This design is not legal advice or a jurisdictional determination. Create a threat model for tenant boundaries, privileged accounts, auction integrity, scorer devices, public realtime, uploads and supply chain. CI should scan dependencies, secrets and containers.

## 7. Non-functional goals and operations

| Measure | Initial requirement |
|---|---|
| Audience | 5,000 concurrent viewers on one match and separately one auction; test reconnect storms. |
| Scoring | 10–50 scorers; test duplicates, stale versions and out-of-order events. |
| Auction | 50 simultaneous bids on a hot lot; preserve accepted order, reservations and finalization. |
| Latency/freshness | Product/engineering must approve numeric p95/p99 and freshness SLO before launch; measure in production-like staging. |
| Durability | A successful bid/delivery acknowledgement follows durable commit. Recover via retry or snapshot. |
| Recovery | Decide RPO/RTO for database, assets and service outage; prove restore/failover. |
| Availability | Set service SLO/error budget after provider and critical dependencies are selected. |

Measure request rate, errors and p50/p95/p99; transaction retry/abort rates; pool saturation; Redis latency; queue depth/age; outbox lag; realtime connections; event publication delay; lease and bid conflicts. Use structured logs with requestId, opaque actor and tenant scope, plus distributed tracing where practical. Alert on user impact and SLO burn, not CPU alone.

Minimum runbooks: database outage/retry storm; Redis failure and queue backlog; realtime gateway restart and resync; auction pause/recovery; scorer lease/offline conflict; stale public projection; suspected tenant exposure; credential compromise; backup restore; regional disaster recovery. Keep customer support contacts and incident communication ownership current.

Environments: local container dependencies, shared integration, production-like staging with synthetic data, isolated production credentials/network/data. Do not copy production personal data into development without approved anonymization. Production topology uses CDN/WAF/load balancer, static web hosting, API/realtime/worker, managed database, Redis/queue, object storage, secrets and telemetry. Provider and region remain open. Use immutable artifacts, health checks, staging smoke tests, gradual rollout and rollback. Run backup restore drills.

## 8. Test and acceptance strategy

The scaffold does not contain or run product tests. Add them with each vertical slice. Required layers:

- Unit: policy matrix, state transitions, purse arithmetic, increments, legal-ball/extras/dismissal matrix, replay, lease epoch and DTO redaction.
- Integration: tenant isolation, transaction retries, idempotency, same-lot bid race, timer race, outbox duplicate, stale/out-of-order scoring, takeover, correction replay and snapshot recovery.
- Acceptance/contract: OpenAPI compatibility and onboarding, tournament setup, player approval, auction, scoring, public visibility and recovery.
- Load/resilience: 5,000 audience, 10–50 scorers, 50 hot-lot bids, reconnect storms, cache misses, slow clients, DB failover, queue backlog, media spikes and tenant fairness.
- Invariants: purse never negative; at most one leader; sold result/roster uniqueness; bid sequence increases; projection equals replay; old epoch rejected; public DTO excludes private fields; tenant A cannot access tenant B.

Acceptance requires tenant isolation; independent player/profile and application; durable idempotent bids and single finalization; stale scorer fencing and deduplicated scoring; public data allowlisting and snapshot recovery; audit, pause/recovery and operational runbooks; signed load, restore and security evidence.

## 9. Delivery gates and team ownership

| Gate | Exit evidence |
|---|---|
| 0 Architecture decisions | Approve database, sessions, tenant model, purse units, auction timing, cricket matrix, public privacy/realtime, queue, provider/region, MFA and minors process; create ADRs. |
| 1 Foundation | Workspace, config, health, DB conventions, indexes/migrations, auth, membership, authorization, audit, error/logging and CI. |
| 2 Tournament/player/team | Tenant → tournament → profile → registration → team/roster vertical slice, contracts and isolation evidence. |
| 3 Auction | Setup → pool → lot → bid → hammer → ledger/result/roster; concurrency, timer race, idempotency and recovery evidence. |
| 4 Scoring | Match → ruleset → lease → delivery → projection → snapshot; corrections, offline conflict and cricket reviewer sign-off. |
| 5 Realtime/operations | Authorized rooms, SSE, reconnect snapshots, workers, dashboards, alerts, runbooks and load exercise. |
| 6 Production readiness | Security/privacy review, restore drill, capacity report, incident/rollback rehearsal, customer support readiness and sign-off. |

Product owner owns scope, plans and acceptance. Engineering lead owns ADRs, contracts, transactions and migration. Domain reviewers validate auction and cricket rules. Security/privacy/legal advisors review risk and safeguarding. QA/reliability owns acceptance/load evidence. DevOps owns topology, secrets, backup and deployment. Customer support/tournament operations owns guides and event coverage.

Release process maintains traceability from requirement to ADR, code and evidence. Use migration-safe expand/deploy/backfill/contract sequencing. Define live-event change freeze and emergency authority. Release record states code/schema/rules versions, known issues, rollback and reconciliation procedure.

## 10. Open decisions and key risks

| ID | Decision | Default to evaluate / owner |
|---|---|---|
| ADR-001 | MongoDB or PostgreSQL | Compare invariants, reporting, queries, operations and team skills; engineering lead. |
| ADR-002 | Schema validation/OpenAPI tools | TypeScript schema-first validation and generated contract checks; engineering. |
| ADR-003 | Frontend server state | Evaluate TanStack Query with offline scoring; frontend lead. |
| ADR-004 | Durable queue | Managed queue or isolated no-eviction Redis queue; DevOps/engineering. |
| ADR-005 | Session transport | Secure HttpOnly cookie where CSRF/topology controls permit; security. |
| ADR-006 | Public live transport | Snapshot API + SSE notice; engineering. |
| ADR-007 | Purse denomination | Integer units and display/rounding policy; product. |
| ADR-008 | Anti-sniping/hammer | Explicit clock, extension and race rules; product/auction operations. |
| ADR-009 | Squad feasibility | Approve min/max roster, categories, reserves; product. |
| ADR-010 | Cricket matrix | Review legal deliveries, innings, follow-on and tie rules; cricket reviewer. |
| ADR-011 | Offline grace | Reject prior epoch after takeover; decide pre-takeover bounded grace; operations. |
| ADR-012 | Provider/region/RPO/RTO | Managed services and tested failover; DevOps/product. |
| ADR-013 | Privileged MFA | Require for platform and tenant admins; security/product. |
| ADR-014 | Minors/consent | Qualified review before data collection; privacy/legal. |
| ADR-015 | Reports/exports | Define format, permissions and retention; product. |

Primary risks are corruption of auction/score state, tenant or personal-data exposure, overclaiming capacity, unresolved customer support obligations, and treating scaffold as finished SaaS. Mitigate with transactions, immutable history, idempotency, replay, explicit DTOs, access tests, measured load, recovery drills and clear incomplete status.

## Appendix A. Implementation-ready module checklist

- Approved state machine, invariants, tenant ownership, schema, indexes and migration plan.
- OpenAPI request/response/error/validation contract and tested permission matrix.
- Transaction, idempotency, concurrency and recovery behavior.
- Event schema, visibility, deduplication and snapshot recovery where relevant.
- Acceptance, invariant, failure and load cases.
- Logs, metrics, alerts, runbook owner, support route and release approver.
- Privacy class, consent and retention rules.

## Appendix B. Launch artifacts

OpenAPI 3.1 and generated clients; schemas and migration scripts; ADRs and permission matrix; auction transition/concurrency evidence; reviewed cricket rules and fixtures; realtime event catalog; threat model and privacy/retention policy; infrastructure-as-code, CI/CD and secret rotation; backup/restore and incident runbooks; load scripts and signed capacity report; SLO/RPO/RTO; onboarding, support and acceptance records.

## Appendix C. Scaffold status

The repo contains monorepo metadata, local MongoDB/Redis compose, an API health entrypoint, a minimal web landing screen, domain module placeholders and documentation directories. It does not implement authentication, tenant isolation, tournament management, auction, scoring, billing, durable jobs, authorized realtime, observability or production infrastructure. The specification is a proposed baseline; open product, legal and provider decisions remain open. Do not deploy this scaffold as production SaaS.

## Appendix D. API, persistence and process contracts

### API endpoint inventory

All paths below require OpenAPI 3.1 schemas, authentication declaration, validation constraints, request/response examples, standard error outcomes and permission mapping before implementation. This inventory is a minimum, not a complete contract.

| Domain | Minimum endpoints |
|---|---|
| Identity | POST `/v1/auth/register`, `/login`, `/refresh`, `/logout`; include verification and recovery flows after policy approval. |
| Tenant | GET/POST `/v1/tenants`; GET/PATCH `/v1/tenants/{tenantId}`; GET/POST `/v1/tenants/{tenantId}/members`; scoped invitations and role assignments. |
| Tournament | GET/POST `/v1/tenants/{tenantId}/tournaments`; GET/PATCH individual tournament; state-transition commands; fixture generation and versioned schedule change. |
| Player | POST `/v1/player-profiles`; GET/PATCH profile by ID subject to field policy; POST tournament registration; organizer review/approval and status endpoints. |
| Team | GET/POST tenant tournament teams; update team and bidder/manager assignments; roster queries and effective-date roster change commands. |
| Auction | Create auction/lots; configure/freeze pool; start/pause/resume; lot open; POST lot bids; hammer/finalize; operator snapshot; public catalogue and results. |
| Match/scoring | Create/read match; acquire/takeover scorer lease; append innings delivery event; append correction; retrieve operator/public score snapshot and event cursor. |
| Public | GET `/public/v1/tournaments/{slug}` and `/public/v1/matches/{id}/snapshot`; publish-only allowlisted catalogue, fixture, standings, sponsor and score data. |
| Sponsor/usage | Campaign CRUD for assigned scope, authorized analytics, plan/usage snapshots and export requests. |

Standard failures should distinguish authentication required, permission denied, resource not found (or intentionally hidden), validation failed, state conflict, stale version, idempotency key mismatch, quota exceeded, rate limited and dependency unavailable. Responses include stable code, safe message and requestId. Never leak stack traces or cross-tenant existence through errors.

### Persistence rules and index examples

Use opaque stable IDs, createdAt/updatedAt, explicit state/version, tenantId on tenant-owned entities, schema version where event compatibility requires it, and compound uniqueness for domain invariants. Index examples to validate against real query plans: unique tenant slug; memberships by tenant/user/status; tournaments by tenant/state/start date; registrations by tenant/tournament/player with uniqueness; teams by tenant/tournament/name; roster entries by tenant/tournament/player/status; auction lots by tenant/auction/sequence and state; bids by tenant/lot/accepted sequence; purse ledger by tenant/account/createdAt; matches by tenant/tournament/start time; ball events by tenant/match/innings/sequence; outbox by status/nextAttemptAt; audit by tenant/resource/time. Apply TTL only to explicitly approved ephemeral records, never financial-like ledgers or required audit history. Set retention and archival before TTL.

Transactions cover the smallest command aggregate that preserves atomic business invariants. Use conditional version/state updates for concurrent commands. A database timeout with unknown commit result is resolved by idempotency key and durable-state inspection. Any behavior relying on multi-document transaction support requires transaction-capable deployment and failover testing.

### Event and job envelope

Domain events include `eventId`, `type`, `schemaVersion`, `aggregateId`, `aggregateVersion`, `occurredAt`, `tenantId` where appropriate, `visibility`, and validated `data`. Do not put private player fields in public event payloads. Consumers track processed IDs or use idempotent aggregate updates. Outbox records have status, attempt count, nextAttemptAt, last safe error class and publishedAt. Retry transient failures with exponential backoff and jitter; send exhausted work to an alerted dead-letter workflow. Keep queue payloads small and fetch authoritative records by ID.

Job families: outbox publication, notification delivery, auction timer sweeps, scheduled tournament/match transitions, public projection refresh, report/export generation, scoring replay/reconciliation and retention/archive. Every job has stable jobId/idempotency key, bounded retries and conditional state transitions. Queue failure must not erase the durable outbox or accepted business state.

### Frontend and offline contract

Organize features for auth, tenant switcher, dashboard, tournaments, players, teams, auction, matches, scoring, public portal, reports and settings. Separate server/cache state, transient UI state, session/tenant context, realtime connection/version state and offline scoring outbox. Do not treat browser state as authority for roles, purse, bids or score.

Offline scorer stores ordered pending events in IndexedDB with generated clientEventId, sequence and prevEventId. Display network state, lease holder/epoch, pending count, last acknowledgement and conflicts. Retry is safe only with the same idempotency key. A conflict provides explicit review/export recovery; never hide or silently merge unresolved events. Public views load without operator credentials and consume only public API DTOs.

### Environment, deployment and data operations

Required configuration includes runtime mode, port, explicit web origin allowlist, database/Redis URLs, session secrets from secret manager, object storage bucket/region, public base URL, logging/telemetry endpoint and feature/ruleset configuration. Production must fail closed if CORS origins or secrets are absent. Do not commit actual secrets to `.env` or logs.

Build separate web static assets, API, realtime and worker artifacts. Health endpoints distinguish liveness from readiness: readiness checks critical dependencies and migrations before receiving traffic. Scale API and worker separately; validate sticky/session requirements for Socket.IO before horizontal scaling. CDN/WAF protects public traffic; database, Redis/queue and object storage remain private where possible. Local Compose services are development-only and not a production topology.

Backups cover database and object assets with encryption, retention, point-in-time recovery where selected, and an exercised restore procedure. Define RPO/RTO and regional recovery ownership. Production data is not copied into development without approved anonymization. Migration plans use expand/deploy/backfill/contract. Document data subject export/deletion, consent withdrawal, minors/guardian handling, audit retention and legal hold in the approved policy.

### Operational service levels and release evidence

Before production, product and engineering must choose numerical availability, API p95/p99, public score freshness, recovery time and data-loss objectives. Capacity tests must state topology, build, dataset, geographic distribution, cache state, reconnect behavior, error rate, throughput, freshness and cost. Do not represent a 5,000-viewer target as achieved without a reproducible report.

Release evidence includes code and schema versions, security scan results, contract compatibility, migrations, target-load report, restore drill, monitoring/alert validation, runbook owners, support readiness, rollback thresholds and product/domain sign-off. Incident reviews record impact, timeline, root cause, recovery, customer communication and corrective actions without exposing sensitive player data.
