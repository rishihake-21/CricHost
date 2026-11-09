# Subscriptions

Each new tenant gets one `UNCONFIGURED` subscription record. Versioned plan definitions keep immutable feature and numeric limit values; lifecycle status can move from `DRAFT` to `ACTIVE` or `RETIRED`, then from `ACTIVE` to `RETIRED`. Definition, lifecycle changes and tenant assignment are audited. An internal provisioning service assigns a plan snapshot to a tenant. Owners/admins can read the tenant subscription. Plan creation and assignment have no public HTTP route until platform-admin authentication/MFA and billing authorization are implemented.

Quota checks run transactionally at tournament, invitation, team, registration, asset storage and sponsor campaign creation. An active plan must explicitly set each currently enforced quota; use `null` for an unmetered dimension. A tenant subscription guard version serializes concurrent quota-consuming commands. Development allows unconfigured tenants so local module work remains usable; production rejects quota-checked commands until the tenant has a configured subscription. A missing limit in an assigned plan still fails closed on the related command.

Billing provider integration, plan administration, payment state transitions, renewal/cancellation policy, past-due/grace behavior, plan change proration and pricing decisions remain open. No monetary price or default quota values are invented in this slice.
