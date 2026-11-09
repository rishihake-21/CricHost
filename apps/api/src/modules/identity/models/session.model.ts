import { model, models, Schema, type InferSchemaType } from "mongoose";

const sessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  accessTokenHash: { type: String, required: true, select: false },
  refreshTokenHash: { type: String, required: true, select: false },
  accessExpiresAt: { type: Date, required: true },
  refreshExpiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  platformMfaVerifiedUntil: { type: Date, default: null },
  userAgent: { type: String, maxlength: 300, default: null },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true, versionKey: false });

sessionSchema.index({ accessTokenHash: 1 }, { unique: true, name: "session_access_hash_unique" });
sessionSchema.index({ refreshTokenHash: 1 }, { unique: true, name: "session_refresh_hash_unique" });
sessionSchema.index({ userId: 1, revokedAt: 1 }, { name: "session_user_active" });
sessionSchema.index({ refreshExpiresAt: 1 }, { expireAfterSeconds: 0, name: "session_refresh_ttl" });

export type SessionRecord = InferSchemaType<typeof sessionSchema>;
export const Session = models.Session ?? model("Session", sessionSchema);
