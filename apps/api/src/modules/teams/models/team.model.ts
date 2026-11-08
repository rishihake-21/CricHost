import { model, models, Schema } from "mongoose";

const teamSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
  shortName: { type: String, default: "", trim: true, maxlength: 20 },
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], required: true, default: "ACTIVE" },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
  createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true, versionKey: false, collection: "teams", strict: "throw" });

teamSchema.index({ tenantId: 1, tournamentId: 1, slug: 1 }, { unique: true, name: "team_tournament_slug_unique" });
teamSchema.index({ tenantId: 1, tournamentId: 1, status: 1, name: 1 }, { name: "team_tournament_status_name" });

export const Team = models.Team ?? model("Team", teamSchema);
