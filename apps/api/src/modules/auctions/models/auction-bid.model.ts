import { model, models, Schema } from "mongoose";

const auctionBidSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  auctionId: { type: Schema.Types.ObjectId, ref: "Auction", required: true },
  lotId: { type: Schema.Types.ObjectId, ref: "AuctionLot", required: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  bidderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  sequence: { type: Number, required: true, min: 1 },
  amount: { type: Number, required: true, min: 1 },
  idempotencyKey: { type: String, required: true, minlength: 16, maxlength: 80 },
  intentHash: { type: String, required: true, minlength: 64, maxlength: 64 },
  expectedLotVersion: { type: Number, required: true, min: 1 },
  lotVersionAfter: { type: Number, required: true, min: 1 },
  acceptedAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false, collection: "auction_bids", strict: "throw" });

auctionBidSchema.index({ tenantId: 1, auctionId: 1, bidderId: 1, idempotencyKey: 1 }, { unique: true, name: "auction_bid_idempotency_unique" });
auctionBidSchema.index({ tenantId: 1, lotId: 1, sequence: 1 }, { unique: true, name: "auction_bid_lot_sequence_unique" });
auctionBidSchema.index({ tenantId: 1, auctionId: 1, teamId: 1, acceptedAt: 1 }, { name: "auction_bid_team_history" });

export const AuctionBid = models.AuctionBid ?? model("AuctionBid", auctionBidSchema);
