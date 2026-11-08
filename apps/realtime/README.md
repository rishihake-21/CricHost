# Realtime gateway

Owns authenticated Socket.IO rooms and public SSE version notifications. Authorize every room join against the principal, tenant and resource assignment. Publish committed events from the transactional outbox only; provide snapshot resynchronization after reconnect.
