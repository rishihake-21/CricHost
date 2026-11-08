# Identity module

Implements local account registration, one-time email verification, password login, opaque token sessions, refresh rotation, logout, authenticated principal lookup and auth endpoint rate limits. Passwords are bcrypt-hashed; access and refresh tokens are random and only their SHA-256 hashes are persisted. Session revocation and account status are checked on authenticated requests.

Registration is deliberately fail-closed in production until an email verification delivery provider is configured. In local development, set `IDENTITY_EXPOSE_DEV_TOKENS=true` to receive the single-use verification token in the registration response. Never enable this setting in production. The email delivery adapter, resend flow, recovery flow and MFA remain unimplemented. Tenant membership authorization is implemented for current organization and team operations.
