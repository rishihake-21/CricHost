import { model, models, Schema } from "mongoose";

const usageEventSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  eventId: { type: String, required: true, maxlength: 120 },
  metric: { type: String, required: true, maxlength: 80 },
  quantity: { type: Number, required: true, min: 0 },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  occurredAt: { type: Date, required: true },
  sourceType: { type: String, required: true, maxlength: 80 },
  sourceId: { type: String, required: true, maxlength: 160 },
  dimensions: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true, versionKey: false, collection: "usage_events", strict: "throw" });

usageEventSchema.index({ tenantId: 1, eventId: 1 }, { unique: true, name: "usage_event_idempotency_unique" });
usageEventSchema.index({ tenantId: 1, periodStart: 1, periodEnd: 1, metric: 1, occurredAt: -1 }, { name: "usage_event_period_metric" });
usageEventSchema.index({ tenantId: 1, sourceType: 1, sourceId: 1, metric: 1 }, { name: "usage_event_source" });

export const UsageEvent = models.UsageEvent ?? model("UsageEvent", usageEventSchema);
