# Audit module

Append-only audit entries for sensitive account, tenant, membership, auction, scoring and administrative actions. Do not store password, token, contact, DOB or document values. The `recordAudit` service removes common sensitive metadata keys and should be written in the same transaction as the business change when atomic audit is required. Database credentials used by production workloads must not have update/delete permission for the audit collection.
