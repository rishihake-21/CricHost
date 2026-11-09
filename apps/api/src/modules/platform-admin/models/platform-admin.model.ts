import { model, models, Schema } from "mongoose";

const platformAdminSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["ACTIVE", "DISABLED"], required: true, default: "ACTIVE" },
  mfaSecretEncrypted: { type: String, default: null, select: false, maxlength: 500 },
  pendingMfaSecretEncrypted: { type: String, default: null, select: false, maxlength: 500 },
  pendingMfaExpiresAt: { type: Date, default: null, select: false },
  pendingMfaPurpose: { type: String, enum: ["ENROLLMENT", "REPLACEMENT"], default: null, select: false },
  pendingMfaSessionId: { type: Schema.Types.ObjectId, ref: "Session", default: null, select: false },
  mfaEnabledAt: { type: Date, default: null },
  lastAcceptedTotpStep: { type: Number, required: true, default: -1, min: -1, select: false },
  recoveryCodeHashes: { type: [String], required: true, default: [], select: false },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "platform_admins", strict: "throw" });

platformAdminSchema.index({ userId: 1 }, { unique: true, name: "platform_admin_user_unique" });
platformAdminSchema.index({ status: 1, mfaEnabledAt: 1 }, { name: "platform_admin_status_mfa" });

export const PlatformAdmin = models.PlatformAdmin ?? model("PlatformAdmin", platformAdminSchema);
