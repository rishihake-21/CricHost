import { model, models, Schema } from "mongoose";

const assetSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  displayName: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
  purpose: { type: String, enum: ["SPONSOR_LOGO", "CAMPAIGN_CREATIVE", "TEAM_BRANDING", "OTHER"], required: true },
  requestedContentType: { type: String, enum: ["image/jpeg", "image/png"], required: true },
  expectedSizeBytes: { type: Number, default: null, min: 1, max: 25 * 1024 * 1024 },
  storageKey: { type: String, default: null, maxlength: 300 },
  contentType: { type: String, enum: ["image/jpeg", "image/png", null], default: null },
  sizeBytes: { type: Number, default: null, min: 1, max: 25 * 1024 * 1024 },
  sha256: { type: String, default: null, match: /^[a-f\d]{64}$/i },
  width: { type: Number, default: null, min: 1, max: 10000 },
  height: { type: Number, default: null, min: 1, max: 10000 },
  metadataStripped: { type: Boolean, required: true, default: false },
  status: { type: String, enum: ["PENDING_UPLOAD", "UPLOADING", "PENDING_SCAN", "PENDING_REVIEW", "APPROVED", "REJECTED", "DELETED"], required: true, default: "PENDING_UPLOAD" },
  scanStatus: { type: String, enum: ["NOT_STARTED", "PENDING", "CLEAN", "INFECTED", "ERROR"], required: true, default: "NOT_STARTED" },
  uploadNonceHash: { type: String, default: null, select: false, maxlength: 64 },
  uploadExpiresAt: { type: Date, default: null },
  uploadClaimToken: { type: String, default: null, select: false, maxlength: 80 },
  uploadClaimExpiresAt: { type: Date, default: null },
  reviewedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  reviewReason: { type: String, default: null, maxlength: 500 },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "assets", strict: "throw" });

assetSchema.index({ tenantId: 1, createdAt: -1, _id: -1 }, { name: "asset_tenant_created" });
assetSchema.index({ tenantId: 1, status: 1, createdAt: -1 }, { name: "asset_tenant_status" });
assetSchema.index({ storageKey: 1 }, { unique: true, partialFilterExpression: { storageKey: { $type: "string" } }, name: "asset_storage_key_unique" });

export const Asset = models.Asset ?? model("Asset", assetSchema);
