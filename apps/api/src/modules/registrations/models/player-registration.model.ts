import { model, models, Schema } from "mongoose";

const registrationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  playerProfileId: { type: Schema.Types.ObjectId, ref: "PlayerProfile", required: true },
  applicantUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  profileSnapshot: { type: Schema.Types.Mixed, required: true },
  status: { type: String, enum: ["PENDING_REVIEW", "APPROVED", "REJECTED", "WITHDRAWN"], required: true, default: "PENDING_REVIEW" },
  consentedAt: { type: Date, required: true },
  consentVersion: { type: String, required: true },
  appliedAt: { type: Date, required: true, default: Date.now },
  reviewedAt: { type: Date, default: null },
  reviewedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
  decisionReason: { type: String, default: null, maxlength: 500 },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "player_tournament_registrations", strict: "throw" });

registrationSchema.index({ tenantId: 1, tournamentId: 1, playerProfileId: 1 }, { unique: true, name: "registration_tournament_player_unique" });
registrationSchema.index({ tenantId: 1, tournamentId: 1, status: 1, appliedAt: 1 }, { name: "registration_tenant_tournament_status" });
registrationSchema.index({ applicantUserId: 1, appliedAt: -1 }, { name: "registration_applicant_history" });

export const PlayerRegistration = models.PlayerRegistration ?? model("PlayerRegistration", registrationSchema);
