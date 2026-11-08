import { model, models, Schema } from "mongoose";

const auctionSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
  slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
  status: { type: String, enum: ["DRAFT", "POOL_APPROVED", "SCHEDULED", "LIVE", "PAUSED", "COMPLETED", "ARCHIVED", "CANCELLED"], required: true, default: "DRAFT" },
  rulesSnapshot: { type: Schema.Types.Mixed, required: true },
  sourceTournamentVersion: { type: Number, required: true, min: 1 },
  sourceRulesVersion: { type: Number, required: true, min: 1 },
  poolSeed: { type: String, default: null, maxlength: 100 },
  poolAlgorithm: { type: String, default: null, maxlength: 100 },
  poolGeneratedAt: { type: Date, default: null },
  poolGeneratedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
  poolSize: { type: Number, required: true, default: 0, min: 0 },
  scheduledAt: { type: Date, default: null },
  startedAt: { type: Date, default: null },
  pausedAt: { type: Date, default: null },
  pausedLotRemainingMs: { type: Number, default: null, min: 0 },
  currentLotId: { type: Schema.Types.ObjectId, ref: "AuctionLot", default: null },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
  createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true, versionKey: false, collection: "auctions", strict: "throw" });

const activeAuctionStates = ["DRAFT", "POOL_APPROVED", "SCHEDULED", "LIVE", "PAUSED", "COMPLETED", "ARCHIVED"];
auctionSchema.index({ tenantId: 1, tournamentId: 1 }, { unique: true, partialFilterExpression: { status: { $in: activeAuctionStates } }, name: "auction_tournament_active_unique" });
auctionSchema.index({ tenantId: 1, slug: 1 }, { unique: true, partialFilterExpression: { status: { $in: activeAuctionStates } }, name: "auction_tenant_slug_active_unique" });
auctionSchema.index({ tenantId: 1, status: 1, createdAt: -1 }, { name: "auction_tenant_status_created" });
auctionSchema.index({ status: 1, currentLotId: 1, updatedAt: 1 }, { name: "auction_live_queue_scan" });

export const Auction = models.Auction ?? model("Auction", auctionSchema);
