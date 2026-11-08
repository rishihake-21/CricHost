import { model, models, Schema } from "mongoose";

const playerProfileSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  displayName: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  bio: { type: String, default: "", maxlength: 500 },
  locationLabel: { type: String, default: "", maxlength: 80 },
  playingRole: { type: String, enum: ["BATTER", "BOWLER", "ALL_ROUNDER", "WICKETKEEPER", "UNKNOWN"], required: true },
  battingHand: { type: String, enum: ["LEFT", "RIGHT", "UNKNOWN"], required: true },
  bowlingStyle: { type: String, enum: ["RIGHT_ARM_FAST", "RIGHT_ARM_MEDIUM", "RIGHT_ARM_OFF_BREAK", "RIGHT_ARM_LEG_BREAK", "LEFT_ARM_FAST", "LEFT_ARM_MEDIUM", "LEFT_ARM_ORTHODOX", "LEFT_ARM_WRIST_SPIN", "NONE", "OTHER", "UNKNOWN"], required: true },
  wicketkeeper: { type: Boolean, required: true, default: false },
  preferredFormats: { type: [String], enum: ["T10", "T20", "ODI", "TEST", "CUSTOM"], default: [] },
  visibility: { type: String, enum: ["PUBLIC", "TOURNAMENTS_ONLY", "PRIVATE"], required: true, default: "TOURNAMENTS_ONLY" },
  status: { type: String, enum: ["ACTIVE", "DISABLED"], required: true, default: "ACTIVE" },
  consentedAt: { type: Date, required: true },
  consentVersion: { type: String, required: true, default: "player-profile-v1" },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "player_profiles", strict: "throw" });

playerProfileSchema.index({ userId: 1 }, { unique: true, name: "player_profile_user_unique" });
playerProfileSchema.index({ visibility: 1, status: 1, displayName: 1 }, { name: "player_profile_public_lookup" });

export const PlayerProfile = models.PlayerProfile ?? model("PlayerProfile", playerProfileSchema);
