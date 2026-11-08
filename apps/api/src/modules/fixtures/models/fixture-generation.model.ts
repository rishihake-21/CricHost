import { model, models, Schema } from "mongoose";

const seededTeamSchema = new Schema({
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  name: { type: String, required: true, maxlength: 100 },
  slug: { type: String, required: true, maxlength: 80 },
  seed: { type: Number, required: true, min: 1 },
  rosterSize: { type: Number, required: true, min: 0 },
}, { _id: false, versionKey: false, strict: "throw" });

const generationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  seed: { type: String, required: true, maxlength: 100 },
  algorithm: { type: String, required: true, enum: ["fisher-yates-sha256-v1+circle-round-robin-v1"] },
  sourceTournamentVersion: { type: Number, required: true, min: 1 },
  generatedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  generatedAt: { type: Date, required: true },
  teamSnapshot: { type: [seededTeamSchema], required: true },
  byeTeamIdsByRound: { type: [[Schema.Types.ObjectId]], default: [] },
  intervalMinutes: { type: Number, required: true, min: 30, max: 1440 },
  durationMinutes: { type: Number, required: true, min: 30, max: 720 },
  scheduleStartAt: { type: Date, required: true },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "fixture_generations", strict: "throw" });

generationSchema.index({ tenantId: 1, tournamentId: 1 }, { unique: true, name: "fixture_generation_tournament_unique" });

export const FixtureGeneration = models.FixtureGeneration ?? model("FixtureGeneration", generationSchema);
