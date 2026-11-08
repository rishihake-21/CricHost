import { model, models, Schema } from "mongoose";

const auctionResultSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  auctionId: { type: Schema.Types.ObjectId, ref: "Auction", required: true },
  lotId: { type: Schema.Types.ObjectId, ref: "AuctionLot", required: true },
  attemptNumber: { type: Number, required: true, min: 1 },
  lotVersionAtFinalization: { type: Number, required: true, min: 1 },
  outcome: { type: String, enum: ["SOLD", "UNSOLD"], required: true },
  winnerTeamId: { type: Schema.Types.ObjectId, ref: "Team", default: null },
  winningBidId: { type: Schema.Types.ObjectId, ref: "AuctionBid", default: null },
  finalPrice: { type: Number, required: true, min: 0 },
  finalizedByType: { type: String, enum: ["USER", "SYSTEM"], required: true, default: "USER" },
  finalizedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
  finalizedAt: { type: Date, required: true },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "auction_results", strict: "throw" });

auctionResultSchema.index({ tenantId: 1, auctionId: 1, lotId: 1, attemptNumber: 1 }, { unique: true, name: "auction_result_lot_attempt_unique" });
auctionResultSchema.index({ tenantId: 1, tournamentId: 1, winnerTeamId: 1, finalizedAt: 1 }, { name: "auction_result_team_history" });

export const AuctionResult = models.AuctionResult ?? model("AuctionResult", auctionResultSchema);
