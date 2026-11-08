import { model, models, Schema } from "mongoose";

const sponsorSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 80, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
  description: { type: String, default: "", maxlength: 1000 },
  websiteUrl: { type: String, default: null, maxlength: 500 },
  logoAssetId: { type: Schema.Types.ObjectId, ref: "Asset", default: null },
  createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "sponsors", strict: "throw" });

sponsorSchema.index({ tenantId: 1, slug: 1 }, { unique: true, name: "sponsor_tenant_slug_unique" });
sponsorSchema.index({ tenantId: 1, name: 1, _id: 1 }, { name: "sponsor_tenant_name" });

export const Sponsor = models.Sponsor ?? model("Sponsor", sponsorSchema);
