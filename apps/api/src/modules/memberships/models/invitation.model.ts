import { model, models, Schema } from "mongoose";

const invitationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  role: { type: String, enum: ["ADMIN", "MEMBER"], required: true },
  status: { type: String, enum: ["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"], required: true, default: "PENDING" },
  tokenHash: { type: String, select: false },
  invitedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  acceptedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
  expiresAt: { type: Date, required: true },
  acceptedAt: { type: Date, default: null },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "tenant_invitations", strict: "throw" });

invitationSchema.index({ tenantId: 1, email: 1 }, { unique: true, partialFilterExpression: { status: "PENDING" }, name: "tenant_pending_invitation_email_unique" });
invitationSchema.index({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $type: "string" } }, name: "tenant_invitation_token_unique" });
invitationSchema.index({ tenantId: 1, status: 1, createdAt: -1 }, { name: "tenant_invitation_status_created" });

export const Invitation = models.TenantInvitation ?? model("TenantInvitation", invitationSchema);
