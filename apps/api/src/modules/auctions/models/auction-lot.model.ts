import { model, models, Schema } from "mongoose";

const auctionPlayerSnapshotSchema = new Schema({
  displayName: { type: String, required: true, maxlength: 80 },
  playingRole: { type: String, required: true, maxlength: 30 },
  battingHand: { type: String, required: true, maxlength: 20 },
  bowlingStyle: { type: String, required: true, maxlength: 40 },
  wicketkeeper: { type: Boolean, required: true },
  preferredFormats: { type: [String], default: [] },
  profileVersion: { type: Number, required: true, min: 1 },
}, { _id: false, versionKey: false, strict: "throw" });

const auctionLotSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  auctionId: { type: Schema.Types.ObjectId, ref: "Auction", required: true },
  lotNumber: { type: Number, required: true, min: 1 },
  attemptNumber: { type: Number, required: true, default: 1, min: 1 },
  reoffersCount: { type: Number, required: true, default: 0, min: 0 },
  registrationId: { type: Schema.Types.ObjectId, ref: "PlayerRegistration", required: true },
  playerProfileId: { type: Schema.Types.ObjectId, ref: "PlayerProfile", required: true },
  player: { type: auctionPlayerSnapshotSchema, required: true },
  openingPrice: { type: Number, required: true, min: 1 },
  currentPrice: { type: Number, required: true, min: 1 },
  leadingTeamId: { type: Schema.Types.ObjectId, ref: "Team", default: null },
  currentBidId: { type: Schema.Types.ObjectId, ref: "AuctionBid", default: null },
  bidSequence: { type: Number, required: true, default: 0, min: 0 },
  status: { type: String, enum: ["QUEUED", "OPEN", "PAUSED", "SOLD", "UNSOLD", "WITHDRAWN"], required: true, default: "QUEUED" },
  openedAt: { type: Date, default: null },
  closesAt: { type: Date, default: null },
  antiSnipingExtensions: { type: Number, required: true, default: 0, min: 0 },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "auction_lots", strict: "throw" });

auctionLotSchema.index({ tenantId: 1, auctionId: 1, lotNumber: 1 }, { unique: true, name: "auction_lot_number_unique" });
auctionLotSchema.index({ tenantId: 1, auctionId: 1, status: 1, lotNumber: 1 }, { name: "auction_lot_queue" });
auctionLotSchema.index({ status: 1, closesAt: 1, tenantId: 1, auctionId: 1 }, { partialFilterExpression: { status: "OPEN" }, name: "auction_lot_expiry_scan" });
auctionLotSchema.index({ tenantId: 1, auctionId: 1, playerProfileId: 1 }, { unique: true, name: "auction_lot_player_unique" });

export const AuctionLot = models.AuctionLot ?? model("AuctionLot", auctionLotSchema);
