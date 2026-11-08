import { model, models, Schema } from "mongoose";

const deliverySchema = new Schema({
  strikerId: { type: Schema.Types.ObjectId, ref: "PlayerProfile", required: true },
  bowlerId: { type: Schema.Types.ObjectId, ref: "PlayerProfile", required: true },
  deliveryType: { type: String, enum: ["LEGAL", "WIDE", "NO_BALL"], required: true },
  batRuns: { type: Number, required: true, min: 0, max: 6 },
  extraType: { type: String, enum: ["NONE", "WIDE", "NO_BALL", "BYE", "LEG_BYE"], required: true },
  extraRuns: { type: Number, required: true, min: 0, max: 6 },
  completedRuns: { type: Number, required: true, min: 0, max: 6 },
  dismissalType: { type: String, enum: ["BOWLED", "CAUGHT", "LBW", "RUN_OUT", "STUMPED", "HIT_WICKET", "OBSTRUCTING_FIELD", null], default: null },
  dismissedPlayerId: { type: Schema.Types.ObjectId, ref: "PlayerProfile", default: null },
}, { _id: false, versionKey: false, strict: "throw" });

const correctionSchema = new Schema({
  targetEventId: { type: Schema.Types.ObjectId, ref: "ScoringEvent", required: true },
  targetSequence: { type: Number, required: true, min: 1 },
  reason: { type: String, required: true, minlength: 10, maxlength: 500 },
  revisedDelivery: { type: deliverySchema, required: true },
}, { _id: false, versionKey: false, strict: "throw" });

const scoringEventSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  matchId: { type: Schema.Types.ObjectId, ref: "Match", required: true },
  inningsId: { type: Schema.Types.ObjectId, ref: "MatchInnings", required: true },
  inningsNumber: { type: Number, required: true, min: 1, max: 4 },
  sequence: { type: Number, required: true, min: 1 },
  clientEventId: { type: String, required: true, maxlength: 36 },
  eventPayloadHash: { type: String, required: true, select: false, maxlength: 64 },
  leaseEpoch: { type: Number, required: true, min: 0 },
  type: { type: String, enum: ["DELIVERY", "CORRECTION"], required: true },
  delivery: { type: deliverySchema, default: null },
  correction: { type: correctionSchema, default: null },
  totalRuns: { type: Number, required: true, min: 0 },
  legalBall: { type: Boolean, required: true },
  createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  occurredAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true, versionKey: false, collection: "scoring_events", strict: "throw" });

scoringEventSchema.index({ tenantId: 1, inningsId: 1, sequence: 1 }, { unique: true, name: "scoring_event_sequence_unique" });
scoringEventSchema.index({ tenantId: 1, inningsId: 1, clientEventId: 1 }, { unique: true, name: "scoring_event_client_id_unique" });
scoringEventSchema.index({ tenantId: 1, matchId: 1, inningsNumber: 1, sequence: 1 }, { name: "scoring_event_match_history" });
scoringEventSchema.index({ tenantId: 1, inningsId: 1, "correction.targetEventId": 1, sequence: 1 }, { name: "scoring_event_correction_history" });
scoringEventSchema.pre("validate", function () {
  if (this.type === "DELIVERY" && (!this.delivery || this.correction)) throw new Error("Delivery event must contain only delivery details");
  if (this.type === "CORRECTION" && (!this.correction || this.delivery)) throw new Error("Correction event must contain only correction details");
});
scoringEventSchema.pre("save", function () {
  if (!this.isNew) throw new Error("Scoring events are append-only");
});
for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  scoringEventSchema.pre(operation, function () { throw new Error("Scoring events are append-only"); });
}

export const ScoringEvent = models.ScoringEvent ?? model("ScoringEvent", scoringEventSchema);
