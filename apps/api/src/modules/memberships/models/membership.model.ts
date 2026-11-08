import { model, models, Schema } from "mongoose";

const membershipSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  role: { type: String, enum: ["OWNER", "ADMIN", "MEMBER"], required: true },
  status: { type: String, enum: ["ACTIVE", "INVITED", "SUSPENDED", "REMOVED"], required: true, default: "ACTIVE" },
  invitedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
  joinedAt: { type: Date, default: Date.now },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "tenant_memberships", strict: "throw" });

membershipSchema.index({ tenantId: 1, userId: 1 }, { unique: true, name: "membership_tenant_user_unique" });
membershipSchema.index({ userId: 1, status: 1, tenantId: 1 }, { name: "membership_user_status" });
membershipSchema.index({ tenantId: 1, status: 1, role: 1 }, { name: "membership_tenant_role" });

export const Membership = models.TenantMembership ?? model("TenantMembership", membershipSchema);
