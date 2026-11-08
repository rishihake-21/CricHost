# Player module

Stores one reusable player profile per CricHost user, independent of tenant and team. The profile has allowlisted cricket and public-summary fields only; exact date of birth, private contacts, identity evidence, guardian data, documents and verified statistics are deliberately absent until safeguarding and privacy decisions are approved. Visibility defaults to `TOURNAMENTS_ONLY`; consent is recorded with the profile.

Profile changes use an expected aggregate version and append audit/outbox records transactionally. Tournament applications use a snapshot of the player profile at application time, so later profile edits do not rewrite what organizers reviewed.
