# Registration module

Creates tournament-scoped applications for active player profiles. Applications require the tournament to be public and currently open for registration, plus explicit participation consent. One application per profile and tournament is enforced by a unique index. Organizers with OWNER or ADMIN membership can list applicants and approve/reject pending applications; decisions are audited and emitted through the outbox transactionally.

Eligibility documents, age rules, minors/guardian workflow, withdrawals, invite-only private tournaments and duplicate-player appeals are not implemented yet.
