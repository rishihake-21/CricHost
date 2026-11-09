# ADR-002 Platform administrator TOTP step-up

- Status: Accepted for the current development phase; production rollout remains gated on bootstrap and recovery procedures.
- Date: 09 November 2026
- Owner: Backend engineering and platform operations

## Context

The backend needs privileged operations for plan provisioning, tenant subscription administration, and dead-letter replay. These actions can change customer access or replay asynchronous side effects, so account login alone is insufficient. The first platform administrators must be explicitly provisioned, and their MFA material must not be stored in plaintext.

## Decision

- Provision platform administrator identities through the `PLATFORM_ADMIN_USER_IDS` environment allowlist. The API does not expose a role-granting endpoint.
- Require an active, email-verified identity from that allowlist for all platform-admin routes.
- Require a password-confirmed TOTP enrollment before privileged access. Encrypt the TOTP secret with AES-256-GCM using a 32-byte deployment-managed key.
- Return ten random, single-use recovery codes at enrollment confirmation and persist only their SHA-256 hashes.
- Require a fresh TOTP or recovery code to elevate the current login session for five minutes. Clear elevation when the refresh token rotates and reject reuse of a TOTP time step.
- Allow an administrator with a usable second factor to replace their authenticator after a fresh step-up and password confirmation. Confirmation rotates recovery codes, revokes other active sessions, and clears the current session's elevation.
- Put plan management, tenant subscription inspection/assignment, and dead-letter listing/replay behind the step-up guard. Audit privileged reads and mutations, require an operator reason for dead-letter replay, omit event payloads from dead-letter listing, and mark platform-admin responses `private, no-store`.

## Alternatives considered

- Login-only authorization: rejected because compromise of a long-lived authenticated browser session would expose high-impact operations.
- Database-stored administrator roles: deferred because role-granting policy and first-admin governance are not yet specified.
- Plaintext TOTP secrets or recovery codes: rejected because a database disclosure would immediately expose second factors.
- SMS MFA: rejected for the current slice because it adds a phone-number dependency and weaker recovery/channel guarantees than TOTP.
- External identity provider and hardware-backed WebAuthn: deferred until identity and production bootstrap requirements are finalized.

## Consequences

- All API replicas must use the same stable encryption key; changing it makes existing encrypted seeds unreadable. Store it in the deployment secret manager and never commit it.
- The administrator allowlist is deployment state and requires a controlled configuration change to grant or revoke access.
- Rate limits currently use process-local memory, so production horizontal scaling requires a shared limiter.
- Production first-admin bootstrap, email verification delivery, recovery when all factors are lost, account recovery, and tenant-administrator MFA remain incomplete. Do not treat this slice as a production-ready identity control until those gates are closed.
- MongoDB transactions are required for one-time TOTP/recovery-code consumption and associated audit writes.

## Revisit when

Before production onboarding of the first platform administrator, before horizontal API scaling, and before adding break-glass recovery or an identity provider.
