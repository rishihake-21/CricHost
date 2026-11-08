import { model, models, Schema } from "mongoose";

const outboxEventSchema = new Schema({
  eventId: { type: String, required: true, unique: true, maxlength: 80 },
  tenantId: { type: Schema.Types.ObjectId, default: null },
  eventType: { type: String, required: true, maxlength: 160 },
  schemaVersion: { type: Number, required: true, min: 1 },
  aggregateType: { type: String, required: true, maxlength: 80 },
  aggregateId: { type: String, required: true, maxlength: 160 },
  aggregateVersion: { type: Number, required: true, min: 1 },
  visibility: { type: String, enum: ["INTERNAL", "TENANT_PRIVATE", "TEAM_PRIVATE", "PUBLIC"], required: true },
  data: { type: Schema.Types.Mixed, required: true },
  status: { type: String, enum: ["PENDING", "PROCESSING", "PUBLISHED", "DEAD"], default: "PENDING", required: true },
  attempts: { type: Number, default: 0, min: 0, required: true },
  availableAt: { type: Date, default: Date.now, required: true },
  workerId: { type: String, default: null, maxlength: 120 },
  leaseToken: { type: String, default: null, select: false },
  leaseExpiresAt: { type: Date, default: null },
  publishedAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: null, maxlength: 120 },
}, { timestamps: true, versionKey: false, collection: "outbox_events", strict: "throw" });

outboxEventSchema.index({ status: 1, availableAt: 1, createdAt: 1 }, { name: "outbox_pending_claim" });
outboxEventSchema.index({ status: 1, leaseExpiresAt: 1 }, { name: "outbox_expired_lease" });
outboxEventSchema.index({ tenantId: 1, aggregateType: 1, aggregateId: 1, aggregateVersion: 1 }, { name: "outbox_aggregate_order" });

export const OutboxEvent = models.OutboxEvent ?? model("OutboxEvent", outboxEventSchema);
