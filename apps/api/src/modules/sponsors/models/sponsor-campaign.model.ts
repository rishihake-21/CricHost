import { model, models, Schema } from "mongoose";

const sponsorCampaignSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
  tournamentId: { type: Schema.Types.ObjectId, ref: "Tournament", required: true },
  sponsorId: { type: Schema.Types.ObjectId, ref: "Sponsor", required: true },
  assetId: { type: Schema.Types.ObjectId, ref: "Asset", required: true },
  placement: { type: String, enum: ["TOURNAMENT_HEADER", "FIXTURE_LIST", "MATCH_PAGE", "SCORECARD"], required: true },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  targetUrl: { type: String, required: true, maxlength: 500 },
  status: { type: String, enum: ["SCHEDULED", "PAUSED", "CANCELLED"], required: true, default: "SCHEDULED" },
  createdById: { type: Schema.Types.ObjectId, ref: "User", required: true },
  aggregateVersion: { type: Number, required: true, default: 1, min: 1 },
}, { timestamps: true, versionKey: false, collection: "sponsor_campaigns", strict: "throw" });

sponsorCampaignSchema.index({ tenantId: 1, tournamentId: 1, status: 1, placement: 1, startsAt: 1, endsAt: 1 }, { name: "sponsor_campaign_placement_window" });
sponsorCampaignSchema.index({ tenantId: 1, tournamentId: 1, createdAt: -1, _id: -1 }, { name: "sponsor_campaign_tenant_list" });
sponsorCampaignSchema.index({ sponsorId: 1, status: 1, startsAt: 1 }, { name: "sponsor_campaign_sponsor_status" });

export const SponsorCampaign = models.SponsorCampaign ?? model("SponsorCampaign", sponsorCampaignSchema);
