import { model, models, Schema } from "mongoose";

const tenantSubscriptionSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  planId: { type: Schema.Types.ObjectId, ref: "SubscriptionPlan", default: null },
  planCode: { type: String, default: null, maxlength: 40 },
  planVersion: { type: Number, default: null, min: 1 },
  status: { type: String, enum: ["UNCONFIGURED", "TRIAL", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED"], required: true, default: "UNCONFIGURED" },
  limitsSnapshot: { type: Schema.Types.Mixed, default: null },
  featuresSnapshot: { type: [String], required: true, default: [] },
  currentPeriodStart: { type: Date, default: null },
  currentPeriodEnd: { type: Date, default: null },
  billingProvider: { type: String, enum: ["NONE", "STRIPE", "OTHER"], required: true, default: "NONE" },
  externalSubscriptionRef: { type: String, default: null, select: false, maxlength: 160 },
  quotaGuardVersion: { type: Number, required: true, default: 0, min: 0, select: false },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "tenant_subscriptions", strict: "throw" });

tenantSubscriptionSchema.index({ tenantId: 1 }, { unique: true, name: "tenant_subscription_unique" });
tenantSubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 }, { name: "tenant_subscription_period_status" });

export const TenantSubscription = models.TenantSubscription ?? model("TenantSubscription", tenantSubscriptionSchema);
