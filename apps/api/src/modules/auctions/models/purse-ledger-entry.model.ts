import { model, models, Schema } from "mongoose";

const purseLedgerEntrySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  auctionId: { type: Schema.Types.ObjectId, ref: "Auction", required: true },
  purseAccountId: { type: Schema.Types.ObjectId, ref: "PurseAccount", required: true },
  teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
  sequence: { type: Number, required: true, min: 1 },
  entryType: { type: String, enum: ["BUDGET_OPENED", "BID_RESERVED", "BID_REPLACED", "BID_RELEASED", "BID_COMMITTED", "ADMIN_ADJUSTMENT"], required: true },
  amount: { type: Number, required: true, min: 0 },
  reservedDelta: { type: Number, required: true },
  committedDelta: { type: Number, required: true },
  resultingReserved: { type: Number, required: true, min: 0 },
  resultingCommitted: { type: Number, required: true, min: 0 },
  referenceId: { type: Schema.Types.ObjectId, default: null },
  actorType: { type: String, enum: ["USER", "SYSTEM"], required: true, default: "USER" },
  actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  reason: { type: String, default: null, maxlength: 500 },
}, { timestamps: true, versionKey: false, collection: "auction_purse_ledger", strict: "throw" });

purseLedgerEntrySchema.index({ tenantId: 1, purseAccountId: 1, sequence: 1 }, { unique: true, name: "purse_ledger_sequence_unique" });
purseLedgerEntrySchema.index({ tenantId: 1, auctionId: 1, teamId: 1, createdAt: 1 }, { name: "purse_ledger_audit" });

export const PurseLedgerEntry = models.PurseLedgerEntry ?? model("PurseLedgerEntry", purseLedgerEntrySchema);
