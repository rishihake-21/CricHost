import { model, models, Schema } from "mongoose";

const usageCounterSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  metric: { type: String, required: true, maxlength: 80 },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  quantity: { type: Number, required: true, min: 0, default: 0 },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "usage_counters", strict: "throw" });

usageCounterSchema.index({ tenantId: 1, metric: 1, periodStart: 1 }, { unique: true, name: "usage_counter_period_metric_unique" });
usageCounterSchema.index({ tenantId: 1, periodStart: 1, periodEnd: 1 }, { name: "usage_counter_tenant_period" });

export const UsageCounter = models.UsageCounter ?? model("UsageCounter", usageCounterSchema);
