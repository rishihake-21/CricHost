import { model, models, Schema } from "mongoose";

const matchScorerSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["ACTIVE", "REMOVED"], required: true, default: "ACTIVE" },
  assignedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  assignedAt: { type: Date, required: true, default: Date.now },
  removedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false, collection: "match_scorers", strict: "throw" });

matchScorerSchema.index({ tenantId:  1, matchId: 1, userId: 1 }, { unique: true, name: "match_scorer_user_unique" });
matchScorerSchema.index({ tenantId: 1, matchId: 1, status: 1 }, { name: "match_scorer_active" });

export const MatchScorer = models.MatchScorer ?? model("MatchScorer", matchScorerSchema);
