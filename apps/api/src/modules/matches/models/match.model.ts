import { model, models, Schema } from "mongoose";

const teamSnapshotSchema = new Schema({
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  name: { type: String, required: true, maxlength: 100 },
  slug: { type: String, required: true, maxlength: 80 },
  seed: { type: Number, required: true, min: 1 },
}, { _id: false, versionKey: false, strict: "throw" });

const rulesSnapshotSchema = new Schema({
  format: { type: String, enum: ["T10", "T20", "ODI", "TEST", "CUSTOM"], required: true },
  inningsPerMatch: { type: Number, required: true, min: 1, max: 4 },
  oversPerInnings: { type: Number, default: null, min: 1, max: 100 },
  ballsPerOver: { type: Number, required: true, min: 4, max: 8 },
  playersPerSide: { type: Number, required: true, min: 2, max: 15 },
  followOnEnabled: { type: Boolean, required: true },
  tiePolicy: { type: String, enum: ["SUPER_OVER", "DRAW", "REPLAY", "POINTS"], required: true },
  pointsForWin: { type: Number, required: true, min: 0, max: 10, default: 2 },
  pointsForTie: { type: Number, required: true, min: 0, max: 10, default: 1 },
  pointsForNoResult: { type: Number, required: true, min: 0, max: 10, default: 1 },
  rulesVersion: { type: Number, required: true, min: 1 },
}, { _id: false, versionKey: false, strict: "throw" });

const matchResultSchema = new Schema({
  outcome: { type: String, enum: ["HOME_WIN", "AWAY_WIN", "TIE", "NO_RESULT"], required: true },
  winnerTeamId: { type: Schema.Types.ObjectId, ref: "Team", default: null },
  marginType: { type: String, enum: ["RUNS", "WICKETS", null], default: null },
  marginValue: { type: Number, default: null, min: 0 },
  decisionMethod: { type: String, enum: ["SCORECARD", "ADMINISTRATIVE"], required: true },
  decidedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
  decidedAt: { type: Date, required: true },
}, { _id: false, versionKey: false, strict: "throw" });

const matchSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  fixtureId: { type: Schema.Types.ObjectId, ref: "Fixture", required: true },
  fixtureNumber: { type: Number, required: true, min: 1 },
  roundNumber: { type: Number, required: true, min: 1 },
  home: { type: teamSnapshotSchema, required: true },
  away: { type: teamSnapshotSchema, required: true },
  homeRosterProfileIds: { type: [{ type: Schema.Types.ObjectId, ref: "PlayerProfile" }], required: true, default: [] },
  awayRosterProfileIds: { type: [{ type: Schema.Types.ObjectId, ref: "PlayerProfile" }], required: true, default: [] },
  scheduledAt: { type: Date, required: true },
  rules: { type: rulesSnapshotSchema, required: true },
  status: { type: String, enum: ["SCHEDULED", "LIVE", "COMPLETED", "ABANDONED"], required: true, default: "SCHEDULED" },
  tossWinnerTeamId: { type: Schema.Types.ObjectId, default: null },
  tossDecision: { type: String, enum: ["BAT", "BOWL", null], default: null },
  firstBattingTeamId: { type: Schema.Types.ObjectId, default: null },
  currentInningsNumber: { type: Number, required: true, default: 0, min: 0, max: 4 },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  result: { type: matchResultSchema, default: null },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
  createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true, versionKey: false, collection: "matches", strict: "throw" });

matchSchema.index({ tenantId: 1, fixtureId: 1 }, { unique: true, name: "match_fixture_unique" });
matchSchema.index({ tenantId: 1, tournamentId: 1, fixtureNumber: 1 }, { name: "match_tournament_fixture" });
matchSchema.index({ tenantId: 1, tournamentId: 1, scheduledAt: 1, status: 1 }, { name: "match_tournament_schedule" });

export const Match = models.Match ?? model("Match", matchSchema);
