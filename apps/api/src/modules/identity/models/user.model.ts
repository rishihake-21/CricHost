import { model, models, Schema, type InferSchemaType } from "mongoose";

const userSchema = new Schema({
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  displayName: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  passwordHash: { type: String, required: true, select: false },
  status: { type: String, enum: ["ACTIVE", "DISABLED"], default: "ACTIVE", required: true },
  emailVerifiedAt: { type: Date, default: null },
  verificationTokenHash: { type: String, default: null, select: false },
  verificationExpiresAt: { type: Date, default: null, select: false },
}, { timestamps: true, versionKey: false });

userSchema.index({ email: 1 }, { unique: true, name: "user_email_unique" });
userSchema.index({ verificationTokenHash: 1 }, { sparse: true, name: "user_verification_token" });

export type UserRecord = InferSchemaType<typeof userSchema>;
export const User = models.User ?? model("User", userSchema);
