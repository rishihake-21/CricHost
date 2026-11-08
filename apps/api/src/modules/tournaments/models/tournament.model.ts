import { model, models, Schema } from "mongoose";

const tournamentSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
  season: { type: String, required: true, trim: true, maxlength: 40 },
  description: { type: String, default: "", maxlength: 2000 },
  timezone: { type: String, required: true, maxlength: 80 },
  locale: { type: String, required: true, maxlength: 35 },
  visibility: { type: String, enum: ["PRIVATE", "PUBLIC"], required: true, default: "PRIVATE" },
  registrationOpensAt: { type: Date, required: true },
  registrationClosesAt: { type: Date, required: true },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  format: { type: String, enum: ["T10", "T20", "ODI", "TEST", "CUSTOM"], required: true },
  structure: { type: String, enum: ["KNOCKOUT", "ROUND_ROBIN", "GROUP_KNOCKOUT"], required: true },
  rulesVersion: { type: Number, required: true, default: 1, min: 1 },
  sponsorInventoryVersion: { type: Number, required: true, default: 0, min: 0 },
  rules: { type: Schema.Types.Mixed, required: true },
  status: { type: String, enum: ["DRAFT", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "SCHEDULED", "LIVE", "COMPLETED", "ARCHIVED"], required: true, default: "DRAFT" },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
  createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true, versionKey: false, collection: "tournaments", strict: "throw" });

tournamentSchema.index({ tenantId: 1, slug: 1 }, { unique: true, name: "tournament_tenant_slug_unique" });
tournamentSchema.index({ tenantId: 1, status: 1, startAt: 1 }, { name: "tournament_tenant_status_start" });
tournamentSchema.index({ tenantId: 1, format: 1, season: 1 }, { name: "tournament_tenant_format_season" });

export const Tournament = models.Tournament ?? model("Tournament", tournamentSchema);
