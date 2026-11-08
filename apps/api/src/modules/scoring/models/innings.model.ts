import { model, models, Schema } from "mongoose";

const extrasSchema = new Schema({
  wides: { type: Number, required: true, default: 0, min: 0 },
  noBalls: { type: Number, required: true, default: 0, min: 0 },
  byes: { type: Number, required: true, default: 0, min: 0 },
  legByes: { type: Number, required: true, default: 0, min: 0 },
}, { _id: false, versionKey: false, strict: "throw" });

const inningsSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
  number: { type: Number, required: true, min: 1, max: 4 },
  battingTeamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  bowlingTeamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  status: { type: String, enum: ["LIVE", "COMPLETED"], required: true, default: "LIVE" },
  closureType: { type: String, enum: ["AUTOMATIC", "MANUAL", null], default: null },
  runs: { type: Number, required: true, default: 0, min: 0 },
  wickets: { type: Number, required: true, default: 0, min: 0 },
  legalBalls: { type: Number, required: true, default: 0, min: 0 },
  extras: { type: extrasSchema, required: true, default: () => ({}) },
  eventHead: { type: Number, required: true, default: 0, min: 0 },
  scorerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  leaseEpoch: { type: Number, required: true, default: 0, min: 0 },
  leaseExpiresAt: { type: Date, default: null },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "match_innings", strict: "throw" });

inningsSchema.index({ tenantId: 1, matchId: 1, number: 1 }, { unique: true, name: "innings_match_number_unique" });
inningsSchema.index({ tenantId: 1, matchId: 1, status: 1 }, { name: "innings_match_status" });

export const Innings = models.MatchInnings ?? model("MatchInnings", inningsSchema);
