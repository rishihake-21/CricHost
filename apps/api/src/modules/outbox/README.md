# Outbox module

Persists versioned domain events in the same MongoDB transaction as the business state change. Workers claim events with expiring leases, publish idempotently, then mark them published; retries use bounded exponential backoff and dead-letter exhausted work. Transport delivery is at least once. Do not enqueue a business event outside the originating transaction.
