import { model, models, Schema } from "mongoose";

const rosterHistorySchema = new Schema({
  action: { type: String, enum: ["ASSIGNED", "RELEASED", "TRANSFERRED"], required: true },
  fromTeamId: { type: Schema.Types.ObjectId, ref: "Team", default: null },
  toTeamId: { type: Schema.Types.ObjectId, ref: "Team", default: null },
  actorType: { type: String, enum: ["USER", "SYSTEM"], required: true, default: "USER" },
  actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  reason: { type: String, default: null, maxlength: 500 },
  occurredAt: { type: Date, required: true, default: Date.now },
}, { _id: false, versionKey: false, strict: "throw" });

const rosterEntrySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  playerProfileId: { type: Schema.Types.ObjectId, ref: "PlayerProfile", required: true },
  registrationId: { type: Schema.Types.ObjectId, ref: "PlayerRegistration", required: true },
  source: { type: String, enum: ["DIRECT_REGISTRATION", "AUCTION_RESULT"], required: true },
  status: { type: String, enum: ["ACTIVE", "RELEASED"], required: true, default: "ACTIVE" },
  assignedAt: { type: Date, required: true, default: Date.now },
  releasedAt: { type: Date, default: null },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
  history: { type: [rosterHistorySchema], default: [] },
}, { timestamps: true, versionKey: false, collection: "team_roster_entries", strict: "throw" });

rosterEntrySchema.index({ tenantId: 1, tournamentId: 1, playerProfileId: 1 }, { unique: true, name: "roster_player_tournament_unique" });
rosterEntrySchema.index({ tenantId: 1, tournamentId: 1, teamId: 1, status: 1 }, { name: "roster_team_active" });
rosterEntrySchema.index({ registrationId: 1 }, { name: "roster_registration_source" });

export const RosterEntry = models.RosterEntry ?? model("RosterEntry", rosterEntrySchema);
