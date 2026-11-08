import { model, models, Schema } from "mongoose";

const teamSnapshotSchema = new Schema({
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  name: { type: String, required: true, maxlength: 100 },
  slug: { type: String, required: true, maxlength: 80 },
  seed: { type: Number, required: true, min: 1 },
}, { _id: false, versionKey: false, strict: "throw" });

const fixtureSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  fixtureNumber: { type: Number, required: true, min: 1 },
  roundNumber: { type: Number, required: true, min: 1 },
  home: { type: teamSnapshotSchema, required: true },
  away: { type: teamSnapshotSchema, required: true },
  startsAt: { type: Date, required: true },
  durationMinutes: { type: Number, required: true, min: 30, max: 720 },
  status: { type: String, enum: ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"], required: true, default: "SCHEDULED" },
  scheduleVersion: { type: Number, required: true, default: 1, min: 1 },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "fixtures", strict: "throw" });

fixtureSchema.index({ tenantId: 1, tournamentId: 1, fixtureNumber: 1 }, { unique: true, name: "fixture_tournament_number_unique" });
fixtureSchema.index({ tenantId: 1, tournamentId: 1, roundNumber: 1, fixtureNumber: 1 }, { name: "fixture_tournament_round_order" });
fixtureSchema.index({ tenantId: 1, tournamentId: 1, startsAt: 1, status: 1 }, { name: "fixture_tournament_schedule" });

export const Fixture = models.Fixture ?? model("Fixture", fixtureSchema);
