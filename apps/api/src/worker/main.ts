import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createClient } from "redis";
import { env } from "../platform/config/env.js";
import { connectDatabase, disconnectDatabase } from "../platform/db/mongoose.js";
import { claimNextOutboxEvent, getOutboxQueueSnapshot, markOutboxEventPublished, retryOutboxEvent, type ClaimedOutboxEvent } from "../modules/outbox/outbox.service.js";

const channel = "crichost:domain-events:v1";
const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, 120);
let stopping = false;
let nextHeartbeatAt = 0;
let publishedSinceHeartbeat = 0;
let retriesSinceHeartbeat = 0;
let lastReportedDeadCount = 0;
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function reportHeartbeat(): Promise<void> {
  const now = Date.now();
  if (now < nextHeartbeatAt) return;
  nextHeartbeatAt = now + env.OUTBOX_HEARTBEAT_INTERVAL_MS;
  try {
    const queue = await getOutboxQueueSnapshot(new Date(now));
    console.info(JSON.stringify({
      event: "outbox_worker_heartbeat",
      workerId,
      intervalMs: env.OUTBOX_HEARTBEAT_INTERVAL_MS,
      publishedSinceHeartbeat,
      retriesSinceHeartbeat,
      queue,
    }));
    if (queue.deadCount > lastReportedDeadCount) {
      console.error(JSON.stringify({ event: "outbox_dead_letter_backlog", workerId, deadCount: queue.deadCount, oldestDeadAgeMs: queue.oldestDeadAgeMs }));
    }
    lastReportedDeadCount = queue.deadCount;
    publishedSinceHeartbeat = 0;
    retriesSinceHeartbeat = 0;
  } catch {
    console.error(JSON.stringify({ event: "outbox_worker_metrics_failed", workerId }));
  }
}

async function run(): Promise<void> {
  if (!env.REDIS_URL) throw new Error("REDIS_URL is required by the outbox publisher");
  await connectDatabase();
  const redis = createClient({ url: env.REDIS_URL });
  redis.on("error", () => console.error(JSON.stringify({ event: "outbox_redis_error", workerId })));
  await redis.connect();
  console.info(JSON.stringify({ event: "outbox_worker_started", workerId, channel }));

  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  try {
    while (!stopping) {
      await reportHeartbeat();
      let event: ClaimedOutboxEvent | null;
      try {
        event = await claimNextOutboxEvent(workerId, env.OUTBOX_LEASE_SECONDS, env.OUTBOX_MAX_ATTEMPTS);
      } catch {
        console.error(JSON.stringify({ event: "outbox_claim_failed", workerId }));
        await wait(1_000);
        continue;
      }
      if (!event) { await wait(env.OUTBOX_POLL_INTERVAL_MS); continue; }

      try {
        const { leaseToken, ...publicEnvelope } = event;
        await redis.publish(channel, JSON.stringify(publicEnvelope));
        const acknowledged = await markOutboxEventPublished(event.eventId, leaseToken);
        if (!acknowledged) console.warn(JSON.stringify({ event: "outbox_lease_lost_after_publish", workerId, eventId: event.eventId }));
        else publishedSinceHeartbeat += 1;
      } catch {
        try {
          const rescheduled = await retryOutboxEvent(event.eventId, event.leaseToken, "REDIS_PUBLISH_FAILED", env.OUTBOX_MAX_ATTEMPTS);
          if (rescheduled && event.attempts >= env.OUTBOX_MAX_ATTEMPTS) {
            console.error(JSON.stringify({ event: "outbox_event_dead_lettered", workerId, eventId: event.eventId, attempts: event.attempts, code: "REDIS_PUBLISH_FAILED" }));
          } else if (rescheduled) {
            retriesSinceHeartbeat += 1;
            console.warn(JSON.stringify({ event: "outbox_publish_retry_scheduled", workerId, eventId: event.eventId, attempts: event.attempts, maxAttempts: env.OUTBOX_MAX_ATTEMPTS }));
          } else {
            console.warn(JSON.stringify({ event: "outbox_retry_not_applied", workerId, eventId: event.eventId }));
          }
        } catch {
          console.error(JSON.stringify({ event: "outbox_retry_schedule_failed", workerId, eventId: event.eventId }));
        }
      }
    }
  } finally {
    await redis.quit().catch(() => undefined);
    await disconnectDatabase();
    console.info(JSON.stringify({ event: "outbox_worker_stopped", workerId }));
  }
}

void run().catch(async (error: unknown) => {
  console.error(JSON.stringify({ event: "outbox_worker_startup_failed", code: error instanceof Error ? error.name : "UNKNOWN" }));
  await disconnectDatabase().catch(() => undefined);
  process.exitCode = 1;
});
