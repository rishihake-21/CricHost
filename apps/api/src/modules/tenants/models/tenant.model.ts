import { model, models, Schema } from "mongoose";

const tenantSchema = new Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
  timezone: { type: String, required: true, maxlength: 80 },
  locale: { type: String, required: true, maxlength: 35, default: "en-US" },
  status: { type: String, enum: ["ACTIVE", "SUSPENDED", "ARCHIVED"], required: true, default: "ACTIVE" },
  createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true, versionKey: false, collection: "tenants", strict: "throw" });

tenantSchema.index({ slug: 1 }, { unique: true, name: "tenant_slug_unique" });
tenantSchema.index({ status: 1, createdAt: -1 }, { name: "tenant_status_created" });

export const Tenant = models.Tenant ?? model("Tenant", tenantSchema);
