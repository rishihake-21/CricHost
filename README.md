# CricHost

Multi-tenant cricket tournament operations SaaS. This repository is the implementation foundation derived from the supplied SaaS Development Specification and Software Low-Level Design. The consolidated implementation reference is in `docs/CricHost_Development_Blueprint.docx`.

## Current state

This is a clean TypeScript monorepo scaffold, not a production implementation. It defines deployable process boundaries and domain module locations. Authentication, tenant policy enforcement, tournament workflows, auction, scoring, billing, integrations, observability and production infrastructure remain to be implemented and reviewed.

## Proposed baseline

- Web: React, TypeScript and Vite.
- API: Node.js, Express and TypeScript; modular monolith split into API, realtime and worker processes.
- Persistence: MongoDB replica set proposal; decision ADR-001 remains open.
- Coordination/cache: Redis proposal; durable queue technology remains open.
- Contracts: OpenAPI 3.1 and shared TypeScript contracts.
- Realtime: authorized Socket.IO for private operator channels; public snapshot API plus SSE version notifications.
- Runtime: containerized local development; managed production services, provider and region undecided.

## Repository map

`apps/web` contains public portal and authenticated workspace. `apps/api` contains versioned HTTP endpoints and domain modules. `apps/realtime` owns authorized Socket.IO/SSE delivery. `apps/worker` runs outbox, timer, projection and scheduled jobs. `packages/contracts` contains shared schemas and API types. `packages/config` contains shared lint/TypeScript conventions. `docs/adr` records decisions. `docs/openapi` is the contract source. `infra` holds local development and deployment definitions.

## Start here

1. Review the development blueprint and close Gate 0 decisions before committing to production data semantics.
2. Install Node.js 20 LTS or newer and pnpm 9 or newer; enable Corepack or install pnpm through the approved toolchain.
3. Copy `.env.example` to `.env.local`, set local service URLs, and start local services with `docker compose up -d`.
4. Run `pnpm install`, then `pnpm dev` after application packages are implemented.

The commands are intended workflow; dependencies and a lockfile are not included, so this scaffold is not runnable end-to-end yet.

## Product boundary

A player is a person with an independent identity. Tournament applications, auction results and roster entries represent season-specific participation rights. Auction purses are internal roster budgets; there is no betting, wagering or real-money wallet in Release 1.
