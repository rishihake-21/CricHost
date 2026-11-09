# Notifications

Notification delivery is not implemented. The outbox provides the durable input for future notification jobs, but the product still needs to define recipient rules, channel preferences, consent, templates, deduplication and retention. Email delivery is also waiting on a provider decision. Do not forward every domain event directly to users; notification policy must select and minimize content for each recipient.
