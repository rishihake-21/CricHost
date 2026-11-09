import { model, models, Schema } from "mongoose";

const subscriptionPlanSchema = new Schema({
  code: { type: String, required: true, uppercase: true, trim: true, maxlength: 40, match: /^[A-Z][A-Z0-9_]*$/ },
  version: { type: Number, required: true, min: 1 },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  status: { type: String, enum: ["DRAFT", "ACTIVE", "RETIRED"], required: true, default: "DRAFT" },
  limits: { type: Schema.Types.Mixed, required: true, default: {} },
  features: { type: [String], required: true, default: [] },
}, { timestamps: true, versionKey: false, collection: "subscription_plans", strict: "throw" });

subscriptionPlanSchema.index({ code: 1, version: 1 }, { unique: true, name: "subscription_plan_version_unique" });
subscriptionPlanSchema.index({ status: 1, code: 1, version: -1 }, { name: "subscription_plan_catalog" });

export const SubscriptionPlan = models.SubscriptionPlan ?? model("SubscriptionPlan", subscriptionPlanSchema);
