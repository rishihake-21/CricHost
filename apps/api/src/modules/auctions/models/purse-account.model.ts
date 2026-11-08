import { model, models, Schema } from "mongoose";

const purseAccountSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  auctionId: { type: Schema.Types.ObjectId, ref: "Auction", required: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  budget: { type: Number, required: true, min: 0 },
  reservedAmount: { type: Number, required: true, default: 0, min: 0 },
  committedAmount: { type: Number, required: true, default: 0, min: 0 },
  playersAcquired: { type: Number, required: true, min: 0 },
  ledgerSequence: { type: Number, required: true, default: 1, min: 1 },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "auction_purse_accounts", strict: "throw" });

purseAccountSchema.index({ tenantId: 1, auctionId: 1, teamId: 1 }, { unique: true, name: "purse_auction_team_unique" });
purseAccountSchema.index({ tenantId: 1, auctionId: 1, committedAmount: 1, reservedAmount: 1 }, { name: "purse_auction_balance" });

export const PurseAccount = models.PurseAccount ?? model("PurseAccount", purseAccountSchema);
