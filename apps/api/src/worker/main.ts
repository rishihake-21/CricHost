import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createClient } from "redis";
import { env } from "../platform/config/env.js";
import { connectDatabase, disconnectDatabase } from "../platform/db/mongoose.js";
import { claimNextOutboxEvent, markOutboxEventPublished, retryOutboxEvent, type ClaimedOutboxEvent } from "../modules/outbox/outbox.service.js";

const channel = "crichost:domain-events:v1";
const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, 120);
let stopping = false;
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

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
      let event: ClaimedOutboxEvent | null;
      try {
        event = await claimNextOutboxEvent(workerId, 30, 12);
      } catch {
        console.error(JSON.stringify({ event: "outbox_claim_failed", workerId }));
        await wait(1_000);
        continue;
      }
      if (!event) { await wait(750); continue; }

      try {
        const { leaseToken, ...publicEnvelope } = event;
        await redis.publish(channel, JSON.stringify(publicEnvelope));
        const acknowledged = await markOutboxEventPublished(event.eventId, leaseToken);
        if (!acknowledged) console.warn(JSON.stringify({ event: "outbox_lease_lost_after_publish", workerId, eventId: event.eventId }));
      } catch {
        try {
          await retryOutboxEvent(event.eventId, event.leaseToken, "REDIS_PUBLISH_FAILED", 12);
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
