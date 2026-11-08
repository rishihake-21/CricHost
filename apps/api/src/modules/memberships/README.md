# Membership module

Contains tenant membership persistence, active membership access guards, invitation lifecycle and role administration. A user can accept a single-use invitation only after verifying the invited email. Invitation and membership state changes write audit and outbox events in the same transaction; invitation token hashes are stored instead of raw tokens. Removing a member retains the membership row, revokes active team staff assignments, and prevents the tenant owner from being removed.

For local development only, set `IDENTITY_EXPOSE_DEV_TOKENS=true` to receive invitation tokens in API responses. Production invitation creation fails closed until an email delivery adapter is configured. Owners can grant administrator access; admins can invite and manage regular members but cannot manage administrators.
