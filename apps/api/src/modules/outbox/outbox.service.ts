import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongoose";
import { z } from "zod";
import { OutboxEvent } from "./models/outbox-event.model.js";

const eventSchema = z.object({
  eventId: z.string().min(1).max(80).optional(),
  tenantId: z.string().optional(),
  eventType: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z0-9_-]+)+$/).max(160),
  schemaVersion: z.number().int().positive(),
  aggregateType: z.string().min(1).max(80),
  aggregateId: z.string().min(1).max(160),
  aggregateVersion: z.number().int().positive(),
  visibility: z.enum(["INTERNAL", "TENANT_PRIVATE", "TEAM_PRIVATE", "PUBLIC"]),
  data: z.record(z.string(), z.unknown()),
});

export type NewOutboxEvent = z.infer<typeof eventSchema>;
export type ClaimedOutboxEvent = {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  tenantId: string | null;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  visibility: "INTERNAL" | "TENANT_PRIVATE" | "TEAM_PRIVATE" | "PUBLIC";
  data: Record<string, unknown>;
  attempts: number;
  leaseToken: string;
};

export async function enqueueOutboxEvent(input: NewOutboxEvent, session: ClientSession): Promise<string> {
  const event = eventSchema.parse(input);
  const dataJson = JSON.stringify(event.data);
  if (dataJson.length > 64 * 1024) throw new Error("Outbox event data exceeds 64 KiB");
  const eventId = event.eventId ?? randomUUID();
  await OutboxEvent.create([{
    ...event,
    eventId,
    data: JSON.parse(dataJson) as Record<string, unknown>,
  }], { session });
  return eventId;
}

export async function claimNextOutboxEvent(workerId: string, leaseSeconds = 30, maxAttempts = 12): Promise<ClaimedOutboxEvent | null> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300) throw new Error("Outbox lease must be between 5 and 300 seconds");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("Outbox maxAttempts must be between 1 and 100");
  const now = new Date();
  await OutboxEvent.updateMany({
    attempts: { $gte: maxAttempts },
    $or: [
      { status: "PENDING" },
      { status: "PROCESSING", leaseExpiresAt: { $lte: now } },
    ],
  }, { $set: { status: "DEAD", lastErrorCode: "MAX_ATTEMPTS_EXCEEDED", leaseToken: null, leaseExpiresAt: null, workerId: null } });

  const leaseToken = randomUUID();
  const event = await OutboxEvent.findOneAndUpdate({
    attempts: { $lt: maxAttempts },
    $or: [
      { status: "PENDING", availableAt: { $lte: now } },
      { status: "PROCESSING", leaseExpiresAt: { $lte: now } },
    ],
  }, {
    $set: { status: "PROCESSING", workerId, leaseToken, leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000) },
    $inc: { attempts: 1 },
  }, { new: true, sort: { availableAt: 1, createdAt: 1 } }).select("+leaseToken");

  if (!event?.leaseToken) return null;
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    tenantId: event.tenantId?.toString() ?? null,
    occurredAt: event.createdAt.toISOString(),
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    visibility: event.visibility,
    data: event.data as Record<string, unknown>,
    attempts: event.attempts,
    leaseToken: event.leaseToken,
  };
}

export async function markOutboxEventPublished(eventId: string, leaseToken: string): Promise<boolean> {
  const result = await OutboxEvent.updateOne(
    { eventId, status: "PROCESSING", leaseToken },
    { $set: { status: "PUBLISHED", publishedAt: new Date(), workerId: null, leaseToken: null, leaseExpiresAt: null, lastErrorCode: null } },
  );
  return result.modifiedCount === 1;
}

export async function retryOutboxEvent(eventId: string, leaseToken: string, errorCode: string, maxAttempts = 12): Promise<boolean> {
  if (!/^[A-Z0-9_.-]{1,120}$/.test(errorCode)) throw new Error("Outbox retry requires a safe error code");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("Outbox maxAttempts must be between 1 and 100");
  const event = await OutboxEvent.findOne({ eventId, status: "PROCESSING", leaseToken }).select("attempts");
  if (!event) return false;
  if (event.attempts >= maxAttempts) {
    const result = await OutboxEvent.updateOne({ _id: event._id, status: "PROCESSING", leaseToken }, {
      $set: { status: "DEAD", lastErrorCode: errorCode.slice(0, 120), workerId: null, leaseToken: null, leaseExpiresAt: null },
    });
    return result.modifiedCount === 1;
  }
  const baseDelay = Math.min(30_000 * (2 ** Math.max(0, event.attempts - 1)), 3_600_000);
  const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
  const result = await OutboxEvent.updateOne({ _id: event._id, status: "PROCESSING", leaseToken }, {
    $set: { status: "PENDING", availableAt: new Date(Date.now() + delay), lastErrorCode: errorCode.slice(0, 120), workerId: null, leaseToken: null, leaseExpiresAt: null },
  });
  return result.modifiedCount === 1;
}
