import { model, models, Schema } from "mongoose";

const standingSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  teamName: { type: String, required: true, maxlength: 100 },
  played: { type: Number, required: true, default: 0, min: 0 },
  won: { type: Number, required: true, default: 0, min: 0 },
  lost: { type: Number, required: true, default: 0, min: 0 },
  tied: { type: Number, required: true, default: 0, min: 0 },
  noResult: { type: Number, required: true, default: 0, min: 0 },
  points: { type: Number, required: true, default: 0, min: 0 },
  runsFor: { type: Number, required: true, default: 0, min: 0 },
  ballsFaced: { type: Number, required: true, default: 0, min: 0 },
  runsAgainst: { type: Number, required: true, default: 0, min: 0 },
  ballsBowled: { type: Number, required: true, default: 0, min: 0 },
  netRunRate: { type: Number, required: true, default: 0 },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
  updatedAt: { type: Date, required: true, default: Date.now },
}, { versionKey: false, collection: "tournament_standings", strict: "throw" });

standingSchema.index({ tenantId: 1, tournamentId: 1, teamId: 1 }, { unique: true, name: "standing_tournament_team_unique" });
standingSchema.index({ tenantId: 1, tournamentId: 1, points: -1, netRunRate: -1, teamName: 1 }, { name: "standing_tournament_order" });

export const TournamentStanding = models.TournamentStanding ?? model("TournamentStanding", standingSchema);
