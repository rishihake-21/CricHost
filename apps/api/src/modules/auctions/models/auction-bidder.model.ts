import { model, models, Schema } from "mongoose";

const auctionBidderSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  auctionId: { type: Schema.Types.ObjectId, ref: "Auction", required: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["ACTIVE", "REMOVED"], required: true, default: "ACTIVE" },
  assignedById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  assignedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true, versionKey: false, collection: "auction_bidders", strict: "throw" });

auctionBidderSchema.index({ tenantId: 1, auctionId: 1, teamId: 1, userId: 1 }, { unique: true, name: "auction_bidder_unique" });
auctionBidderSchema.index({ tenantId: 1, auctionId: 1, userId: 1, status: 1 }, { name: "auction_bidder_user_scope" });

export const AuctionBidder = models.AuctionBidder ?? model("AuctionBidder", auctionBidderSchema);
