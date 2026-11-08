import { model, models, Schema } from "mongoose";

const teamStaffSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  roles: { type: [String], enum: ["OWNER", "MANAGER", "BIDDER"], required: true },
  status: { type: String, enum: ["ACTIVE", "REMOVED"], required: true, default: "ACTIVE" },
  assignedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  assignedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true, versionKey: false, collection: "team_staff", strict: "throw" });

teamStaffSchema.index({ teamId: 1, userId: 1 }, { unique: true, name: "team_staff_user_unique" });
teamStaffSchema.index({ tenantId: 1, tournamentId: 1, userId: 1, status: 1 }, { name: "team_staff_scope_user" });

export const TeamStaff = models.TeamStaff ?? model("TeamStaff", teamStaffSchema);
