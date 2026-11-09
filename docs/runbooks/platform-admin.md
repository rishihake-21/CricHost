# Platform administrator access

- Owner: Platform operations
- Applies to: API deployments with platform administrator routes enabled
- State: Development procedure; production bootstrap and MFA reset tooling are not yet implemented

## Configure the allowlist and encryption key

1. Confirm the target user exists, has a verified email address, and has an active account. Production email verification delivery is currently not implemented, so production onboarding must wait for that integration or an approved identity/bootstrap process.
2. Obtain the user's MongoDB ObjectId through an approved administrative channel. Add it to `PLATFORM_ADMIN_USER_IDS` as a comma-separated value. The application validates the format at startup.
3. Generate 32 random bytes using the organization's secret manager or an approved cryptographic utility (for example, `openssl rand -hex 32`). Store the resulting 64-character hexadecimal value as `PLATFORM_MFA_ENCRYPTION_KEY` in the deployment secret manager. Do not place it in source control, tickets, or logs.
4. Deploy the same allowlist and encryption key to every API instance. Restart the API. Startup fails if the allowlist is configured without a valid encryption key.
5. If the API is behind a reverse proxy, set `TRUST_PROXY_HOPS` to the exact trusted proxy count so process-local rate limiting sees the intended client address.

## Enroll the administrator

1. The administrator signs in and verifies their email through the configured identity process.
2. Call `POST /v1/platform-admin/mfa/enroll` with the account password. Enrollment is limited to three attempts per hour per API process.
3. Register the returned `otpauth://` URI with an authenticator app. The response contains the TOTP secret, is marked `Cache-Control: private, no-store`, and must not be copied into logs or support tickets.
4. Call `POST /v1/platform-admin/mfa/confirm` with a current six-digit code. Save all ten returned recovery codes in the organization's approved password manager. They are shown once; only hashes are stored.
5. Call `POST /v1/platform-admin/mfa/verify` with a TOTP or unused recovery code before accessing privileged routes. Step-up is bound to that login session for five minutes. Refreshing the session clears it.

## Handle lost credentials or suspected compromise

1. If a recovery code remains, use it once at `/v1/platform-admin/mfa/verify`, then rotate or revoke the affected login session and report the event to the security owner.
2. If no recovery code is available, remove the affected ID from `PLATFORM_ADMIN_USER_IDS` and redeploy immediately to deny platform-admin API access. Preserve relevant audit records and follow the incident process.
3. The application currently has no supported MFA reset/replacement workflow. Do not manually edit encrypted secret fields or mark MFA enabled in MongoDB. A recovery requires an approved, reviewed operational procedure and tracked change; implement the reset workflow before production reliance on this control.
4. If the encryption key is lost or changed, existing TOTP seeds cannot be decrypted. Keep the key backed up in the secret manager's recovery process and coordinate key rotation with a supported MFA reset before changing it.

## Operational limits

- Enrollment and step-up attempt limits are process-local. A shared store is required before running multiple API replicas; otherwise an attacker may distribute attempts across replicas and normal users may receive inconsistent limits.
- Sensitive platform-admin responses are not cacheable. Dead-letter listing excludes event payloads; replay requires a reason and writes an audit entry.
- Production first-admin bootstrap, email delivery, recovery/reset automation, shared rate limiting, and identity lifecycle controls remain release gates.
