# ADR-001 MongoDB implementation adapter

- Status: Accepted for the current development phase; production selection remains subject to Gate 0 review.
- Date: 08 November 2026
- Context: The supplied low-level design and starter scaffold use MongoDB/Mongoose. The SaaS specification still lists database selection as open. User direction is to proceed module by module, and identity/session records are already being implemented against the existing Mongoose dependency.
- Decision: Use MongoDB with Mongoose as the persistence adapter for the initial backend modules. Keep domain services independent of direct HTTP concerns. Validate replica set transactions, indexes, reporting/query needs, operational recovery and team experience before production commitment.
- Consequences: Development uses the current Mongoose package and local MongoDB service. Auction and scoring commands must not be implemented with unsafe read-modify-save flows. Transaction-dependent modules must require a transaction-capable database deployment. A database change before production may require rewriting repositories and migrations.
- Revisit when: Before production schema migrations and before implementing the first transaction-dependent auction command.
