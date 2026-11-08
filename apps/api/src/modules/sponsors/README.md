# Sponsors

Tenant owners/admins can create and update sponsor profiles, schedule campaigns, edit future campaigns, and pause, resume or cancel them. A sponsor campaign references an approved same-tenant `CAMPAIGN_CREATIVE` asset and must fit inside the tournament start/end window. One campaign may reserve a fixed placement at a time; overlapping reservations are blocked. The tournament's internal sponsor-inventory version serializes competing placement writes.

The public read model is available only for public tournaments and includes campaigns inside their current time window whose creative remains approved, clean and metadata-stripped. Campaign creatives and sponsor logos are served through campaign-scoped URLs with `nosniff`, sandbox and `no-store` headers so pauses and cancellations take effect on the next request. Sponsor contact details are not collected or exposed. Website and campaign destinations must use HTTPS.

Not implemented yet: campaign performance/analytics and consent policy, billing and quotas, external sponsor self-service, campaign approval separate from asset moderation, automated status cleanup, production CDN/object storage and delivery reporting. Analytics should wait until the product defines consent, deduplication, retention and reporting permissions.
