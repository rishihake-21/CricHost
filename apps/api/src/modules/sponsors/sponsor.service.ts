import { Types, type ClientSession } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { Asset } from "../assets/models/asset.model.js";
import { getAssetContent } from "../assets/asset.service.js";
import { Tournament } from "../tournaments/models/tournament.model.js";
import { Sponsor } from "./models/sponsor.model.js";
import { SponsorCampaign } from "./models/sponsor-campaign.model.js";
import type { CreateCampaignInput, CreateSponsorInput, UpdateCampaignInput, UpdateSponsorInput } from "./sponsor.schemas.js";

const validId = (id: string) => Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);
const sponsorDto = (sponsor: { _id: Types.ObjectId; name: string; slug: string; description: string; websiteUrl: string | null; logoAssetId: Types.ObjectId | null; aggregateVersion: number; createdAt: Date; updatedAt: Date }) => ({
  id: sponsor._id.toString(), name: sponsor.name, slug: sponsor.slug, description: sponsor.description,
  websiteUrl: sponsor.websiteUrl, logoAssetId: sponsor.logoAssetId?.toString() ?? null,
  version: sponsor.aggregateVersion, createdAt: sponsor.createdAt, updatedAt: sponsor.updatedAt,
});
const campaignDto = (campaign: { _id: Types.ObjectId; tournamentId: Types.ObjectId; sponsorId: Types.ObjectId; assetId: Types.ObjectId; placement: string; startsAt: Date; endsAt: Date; targetUrl: string; status: string; aggregateVersion: number; createdAt: Date; updatedAt: Date }) => ({
  id: campaign._id.toString(), tournamentId: campaign.tournamentId.toString(), sponsorId: campaign.sponsorId.toString(),
  assetId: campaign.assetId.toString(), placement: campaign.placement,
  startsAt: campaign.startsAt, endsAt: campaign.endsAt, targetUrl: campaign.targetUrl,
  status: campaign.status, version: campaign.aggregateVersion, createdAt: campaign.createdAt, updatedAt: campaign.updatedAt,
});

async function requireApprovedAsset(tenantId: string, assetId: string, purpose: "SPONSOR_LOGO" | "CAMPAIGN_CREATIVE", session: ClientSession) {
  if (!validId(assetId)) throw new AppError(404, "ASSET_NOT_FOUND", "Approved image was not found");
  const asset = await Asset.findOne({ _id: assetId, tenantId, purpose, status: "APPROVED", scanStatus: "CLEAN", metadataStripped: true }).select("_id").session(session);
  if (!asset) throw new AppError(409, "APPROVED_ASSET_REQUIRED", "Select an approved, scanned image for this use");
  return asset;
}

async function reservePlacement(tenantId: string, tournamentId: string, placement: string, startsAt: Date, endsAt: Date, session: ClientSession, excludeCampaignId?: string) {
  const tournament = await Tournament.findOne({ _id: tournamentId, tenantId }).session(session);
  if (!tournament) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  if (startsAt < tournament.startAt || endsAt > tournament.endAt || startsAt >= endsAt) {
    throw new AppError(400, "CAMPAIGN_OUTSIDE_TOURNAMENT_WINDOW", "Campaign dates must fall within the tournament start and end dates");
  }
  // This write serializes competing inventory reservations for this tournament.
  tournament.sponsorInventoryVersion += 1;
  await tournament.save({ session });
  const occupied = await SponsorCampaign.exists({
    tenantId, tournamentId, placement, status: { $in: ["SCHEDULED", "PAUSED"] },
    startsAt: { $lt: endsAt }, endsAt: { $gt: startsAt },
    ...(excludeCampaignId ? { _id: { $ne: excludeCampaignId } } : {}),
  }).session(session);
  if (occupied) throw new AppError(409, "SPONSOR_PLACEMENT_UNAVAILABLE", "Another campaign already reserves this placement during part of that window");
  return tournament;
}

export async function createSponsor(tenantId: string, actorId: string, requestId: string, input: CreateSponsorInput) {
  if (!validId(tenantId)) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
  try {
    return await withTransaction(async (session: ClientSession) => {
      if (input.logoAssetId) await requireApprovedAsset(tenantId, input.logoAssetId, "SPONSOR_LOGO", session);
      const [sponsor] = await Sponsor.create([{
        tenantId, createdById: actorId, name: input.name, slug: input.slug,
        description: input.description, websiteUrl: input.websiteUrl ?? null,
        logoAssetId: input.logoAssetId ?? null, aggregateVersion: 1,
      }], { session });
      if (!sponsor) throw new Error("Sponsor creation returned no record");
      await recordAudit({ actorType: "USER", actorId, tenantId, action: "sponsor.created", outcome: "SUCCEEDED", resourceType: "sponsor", resourceId: sponsor.id, requestId, metadata: { slug: sponsor.slug, logoAssetId: sponsor.logoAssetId?.toString() ?? null } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "sponsor.created", schemaVersion: 1, aggregateType: "sponsor", aggregateId: sponsor.id, aggregateVersion: 1, visibility: "TENANT_PRIVATE", data: { sponsorId: sponsor.id, name: sponsor.name, slug: sponsor.slug } }, session);
      return sponsorDto(sponsor);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "SPONSOR_SLUG_TAKEN", "That sponsor URL is already in use in this organization");
    throw error;
  }
}

export async function listSponsors(tenantId: string, limit: number) {
  if (!validId(tenantId)) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
  const rows = await Sponsor.find({ tenantId }).sort({ name: 1, _id: 1 }).limit(limit).lean();
  return rows.map((row) => sponsorDto(row as unknown as Parameters<typeof sponsorDto>[0]));
}

export async function updateSponsor(tenantId: string, sponsorId: string, actorId: string, requestId: string, input: UpdateSponsorInput) {
  if (!validId(sponsorId)) throw new AppError(404, "SPONSOR_NOT_FOUND", "Sponsor was not found");
  return withTransaction(async (session: ClientSession) => {
    const sponsor = await Sponsor.findOne({ _id: sponsorId, tenantId }).session(session);
    if (!sponsor) throw new AppError(404, "SPONSOR_NOT_FOUND", "Sponsor was not found");
    if (sponsor.aggregateVersion !== input.expectedVersion) throw new AppError(409, "STALE_SPONSOR_VERSION", "Sponsor changed; reload before retrying", { currentVersion: sponsor.aggregateVersion });
    if (input.logoAssetId) await requireApprovedAsset(tenantId, input.logoAssetId, "SPONSOR_LOGO", session);
    if (input.name !== undefined) sponsor.name = input.name;
    if (input.description !== undefined) sponsor.description = input.description;
    if (input.websiteUrl !== undefined) sponsor.websiteUrl = input.websiteUrl;
    if (input.logoAssetId !== undefined) sponsor.logoAssetId = input.logoAssetId ? new Types.ObjectId(input.logoAssetId) : null;
    sponsor.aggregateVersion += 1;
    await sponsor.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "sponsor.updated", outcome: "SUCCEEDED", resourceType: "sponsor", resourceId: sponsor.id, requestId, metadata: { version: sponsor.aggregateVersion } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "sponsor.updated", schemaVersion: 1, aggregateType: "sponsor", aggregateId: sponsor.id, aggregateVersion: sponsor.aggregateVersion, visibility: "TENANT_PRIVATE", data: { sponsorId: sponsor.id, version: sponsor.aggregateVersion } }, session);
    return sponsorDto(sponsor);
  });
}

export async function createCampaign(tenantId: string, tournamentId: string, actorId: string, requestId: string, input: CreateCampaignInput) {
  if (!validId(tournamentId) || !validId(input.sponsorId) || !validId(input.assetId)) throw new AppError(404, "CAMPAIGN_REFERENCE_NOT_FOUND", "Tournament, sponsor or image was not found");
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  return withTransaction(async (session: ClientSession) => {
    const sponsor = await Sponsor.findOne({ _id: input.sponsorId, tenantId }).select("_id").session(session);
    if (!sponsor) throw new AppError(404, "SPONSOR_NOT_FOUND", "Sponsor was not found");
    await requireApprovedAsset(tenantId, input.assetId, "CAMPAIGN_CREATIVE", session);
    await reservePlacement(tenantId, tournamentId, input.placement, startsAt, endsAt, session);
    const [campaign] = await SponsorCampaign.create([{
      tenantId, tournamentId, sponsorId: input.sponsorId, assetId: input.assetId,
      placement: input.placement, startsAt, endsAt, targetUrl: input.targetUrl,
      status: "SCHEDULED", createdById: actorId, aggregateVersion: 1,
    }], { session });
    if (!campaign) throw new Error("Campaign creation returned no record");
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "sponsor_campaign.created", outcome: "SUCCEEDED", resourceType: "sponsor_campaign", resourceId: campaign.id, requestId, metadata: { tournamentId, sponsorId: input.sponsorId, placement: input.placement, startsAt, endsAt } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "sponsor_campaign.created", schemaVersion: 1, aggregateType: "sponsor_campaign", aggregateId: campaign.id, aggregateVersion: 1, visibility: "TENANT_PRIVATE", data: { campaignId: campaign.id, tournamentId, sponsorId: input.sponsorId, placement: campaign.placement, status: campaign.status } }, session);
    return campaignDto(campaign);
  });
}

export async function listCampaigns(tenantId: string, tournamentId: string, limit: number, status?: string) {
  if (!validId(tournamentId)) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  const exists = await Tournament.exists({ _id: tournamentId, tenantId });
  if (!exists) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  const rows = await SponsorCampaign.find({ tenantId, tournamentId, ...(status ? { status } : {}) }).sort({ startsAt: 1, _id: 1 }).limit(limit).lean();
  return rows.map((row) => campaignDto(row as unknown as Parameters<typeof campaignDto>[0]));
}

export async function updateCampaign(tenantId: string, tournamentId: string, campaignId: string, actorId: string, requestId: string, input: UpdateCampaignInput) {
  if (!validId(tournamentId) || !validId(campaignId)) throw new AppError(404, "SPONSOR_CAMPAIGN_NOT_FOUND", "Campaign was not found");
  return withTransaction(async (session: ClientSession) => {
    const campaign = await SponsorCampaign.findOne({ _id: campaignId, tenantId, tournamentId }).session(session);
    if (!campaign) throw new AppError(404, "SPONSOR_CAMPAIGN_NOT_FOUND", "Campaign was not found");
    if (campaign.aggregateVersion !== input.expectedVersion) throw new AppError(409, "STALE_SPONSOR_CAMPAIGN_VERSION", "Campaign changed; reload before retrying", { currentVersion: campaign.aggregateVersion });
    if (campaign.status === "CANCELLED" || campaign.startsAt <= new Date()) throw new AppError(409, "SPONSOR_CAMPAIGN_LOCKED", "Only a future, non-cancelled campaign can be edited");
    const nextPlacement = input.placement ?? campaign.placement;
    const nextStartsAt = input.startsAt ? new Date(input.startsAt) : campaign.startsAt;
    const nextEndsAt = input.endsAt ? new Date(input.endsAt) : campaign.endsAt;
    if (nextStartsAt >= nextEndsAt) throw new AppError(400, "CAMPAIGN_WINDOW_INVALID", "Campaign end must be after its start");
    if (input.assetId) await requireApprovedAsset(tenantId, input.assetId, "CAMPAIGN_CREATIVE", session);
    await reservePlacement(tenantId, tournamentId, nextPlacement, nextStartsAt, nextEndsAt, session, campaign.id);
    if (input.assetId !== undefined) campaign.assetId = new Types.ObjectId(input.assetId);
    campaign.placement = nextPlacement;
    campaign.startsAt = nextStartsAt;
    campaign.endsAt = nextEndsAt;
    if (input.targetUrl !== undefined) campaign.targetUrl = input.targetUrl;
    campaign.aggregateVersion += 1;
    await campaign.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "sponsor_campaign.updated", outcome: "SUCCEEDED", resourceType: "sponsor_campaign", resourceId: campaign.id, requestId, metadata: { placement: campaign.placement, startsAt: campaign.startsAt, endsAt: campaign.endsAt, version: campaign.aggregateVersion } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "sponsor_campaign.updated", schemaVersion: 1, aggregateType: "sponsor_campaign", aggregateId: campaign.id, aggregateVersion: campaign.aggregateVersion, visibility: "TENANT_PRIVATE", data: { campaignId: campaign.id, placement: campaign.placement, status: campaign.status, version: campaign.aggregateVersion } }, session);
    return campaignDto(campaign);
  });
}

export async function changeCampaignState(tenantId: string, tournamentId: string, campaignId: string, actorId: string, requestId: string, input: { expectedVersion: number; action: "PAUSE" | "RESUME" | "CANCEL"; reason: string }) {
  if (!validId(tournamentId) || !validId(campaignId)) throw new AppError(404, "SPONSOR_CAMPAIGN_NOT_FOUND", "Campaign was not found");
  return withTransaction(async (session: ClientSession) => {
    const campaign = await SponsorCampaign.findOne({ _id: campaignId, tenantId, tournamentId }).session(session);
    if (!campaign) throw new AppError(404, "SPONSOR_CAMPAIGN_NOT_FOUND", "Campaign was not found");
    if (campaign.aggregateVersion !== input.expectedVersion) throw new AppError(409, "STALE_SPONSOR_CAMPAIGN_VERSION", "Campaign changed; reload before retrying", { currentVersion: campaign.aggregateVersion });
    const now = new Date();
    if (input.action === "PAUSE") {
      if (campaign.status !== "SCHEDULED") throw new AppError(409, "INVALID_CAMPAIGN_TRANSITION", "Only a scheduled campaign can be paused");
      campaign.status = "PAUSED";
    } else if (input.action === "RESUME") {
      if (campaign.status !== "PAUSED" || campaign.endsAt <= now) throw new AppError(409, "INVALID_CAMPAIGN_TRANSITION", "Only a paused campaign whose window has not ended can be resumed");
      await reservePlacement(tenantId, tournamentId, campaign.placement, campaign.startsAt, campaign.endsAt, session, campaign.id);
      campaign.status = "SCHEDULED";
    } else {
      if (campaign.status === "CANCELLED") throw new AppError(409, "INVALID_CAMPAIGN_TRANSITION", "Campaign is already cancelled");
      campaign.status = "CANCELLED";
    }
    campaign.aggregateVersion += 1;
    await campaign.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "sponsor_campaign.state_changed", outcome: "SUCCEEDED", resourceType: "sponsor_campaign", resourceId: campaign.id, requestId, reason: input.reason, metadata: { action: input.action, status: campaign.status, version: campaign.aggregateVersion } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "sponsor_campaign.state_changed", schemaVersion: 1, aggregateType: "sponsor_campaign", aggregateId: campaign.id, aggregateVersion: campaign.aggregateVersion, visibility: "TENANT_PRIVATE", data: { campaignId: campaign.id, status: campaign.status, version: campaign.aggregateVersion } }, session);
    return campaignDto(campaign);
  });
}

export async function listPublicSponsorPlacements(tournamentId: string, placement?: string) {
  if (!validId(tournamentId)) throw new AppError(404, "PUBLIC_SPONSORS_NOT_FOUND", "Public tournament sponsors were not found");
  return withTransaction(async (session) => {
    const tournament = await Tournament.findOne({ _id: tournamentId, visibility: "PUBLIC" }).select("_id tenantId").session(session);
    if (!tournament) throw new AppError(404, "PUBLIC_SPONSORS_NOT_FOUND", "Public tournament sponsors were not found");
    const now = new Date();
    const campaigns = await SponsorCampaign.find({
      tenantId: tournament.tenantId, tournamentId: tournament._id, status: "SCHEDULED",
      startsAt: { $lte: now }, endsAt: { $gt: now }, ...(placement ? { placement } : {}),
    }).sort({ placement: 1, startsAt: 1, _id: 1 }).lean();
    if (!campaigns.length) return { placements: [], snapshotAt: now };
    const sponsorIds = [...new Set(campaigns.map((campaign) => campaign.sponsorId.toString()))];
    const assetIds = [...new Set(campaigns.map((campaign) => campaign.assetId.toString()))];
    const sponsors = await Sponsor.find({ _id: { $in: sponsorIds }, tenantId: tournament.tenantId }).select("name slug websiteUrl logoAssetId").session(session).lean();
    const assets = await Asset.find({ _id: { $in: assetIds }, tenantId: tournament.tenantId, purpose: "CAMPAIGN_CREATIVE", status: "APPROVED", scanStatus: "CLEAN", metadataStripped: true }).select("_id contentType width height").session(session).lean();
    const logoAssetIds = [...new Set(sponsors.flatMap((sponsor) => sponsor.logoAssetId ? [sponsor.logoAssetId.toString()] : []))];
    const logos = logoAssetIds.length ? await Asset.find({ _id: { $in: logoAssetIds }, tenantId: tournament.tenantId, purpose: "SPONSOR_LOGO", status: "APPROVED", scanStatus: "CLEAN", metadataStripped: true }).select("_id").session(session).lean() : [];
    const sponsorById = new Map(sponsors.map((sponsor) => [sponsor._id.toString(), sponsor]));
    const assetById = new Map(assets.map((asset) => [asset._id.toString(), asset]));
    const logoIds = new Set(logos.map((asset) => asset._id.toString()));
    const placements = campaigns.flatMap((campaign) => {
      const sponsor = sponsorById.get(campaign.sponsorId.toString());
      const asset = assetById.get(campaign.assetId.toString());
      if (!sponsor || !asset) return [];
      return [{
        campaignId: campaign._id.toString(), placement: campaign.placement,
        sponsor: { name: sponsor.name, slug: sponsor.slug, websiteUrl: sponsor.websiteUrl },
        logoUrl: sponsor.logoAssetId && logoIds.has(sponsor.logoAssetId.toString()) ? `/public/v1/tournaments/${tournament._id.toString()}/sponsors/${campaign._id.toString()}/logo` : null,
        creativeUrl: `/public/v1/tournaments/${tournament._id.toString()}/sponsors/${campaign._id.toString()}/creative`,
        creative: { contentType: asset.contentType, width: asset.width, height: asset.height },
        targetUrl: campaign.targetUrl, startsAt: campaign.startsAt, endsAt: campaign.endsAt,
      }];
    });
    return { placements, snapshotAt: now };
  });
}

export async function getPublicSponsorCreative(tournamentId: string, campaignId: string) {
  if (!validId(tournamentId) || !validId(campaignId)) throw new AppError(404, "PUBLIC_SPONSOR_CREATIVE_NOT_FOUND", "Sponsor creative was not found");
  const now = new Date();
  const context = await withTransaction(async (session) => {
    const tournament = await Tournament.findOne({ _id: tournamentId, visibility: "PUBLIC" }).select("_id tenantId").session(session);
    if (!tournament) throw new AppError(404, "PUBLIC_SPONSOR_CREATIVE_NOT_FOUND", "Sponsor creative was not found");
    const campaign = await SponsorCampaign.findOne({ _id: campaignId, tournamentId: tournament._id, tenantId: tournament.tenantId, status: "SCHEDULED", startsAt: { $lte: now }, endsAt: { $gt: now } }).select("assetId sponsorId").session(session);
    if (!campaign) throw new AppError(404, "PUBLIC_SPONSOR_CREATIVE_NOT_FOUND", "Sponsor creative was not found");
    const sponsor = await Sponsor.exists({ _id: campaign.sponsorId, tenantId: tournament.tenantId }).session(session);
    const asset = await Asset.exists({ _id: campaign.assetId, tenantId: tournament.tenantId, purpose: "CAMPAIGN_CREATIVE", status: "APPROVED", scanStatus: "CLEAN", metadataStripped: true }).session(session);
    if (!sponsor || !asset) throw new AppError(404, "PUBLIC_SPONSOR_CREATIVE_NOT_FOUND", "Sponsor creative was not found");
    return { tenantId: tournament.tenantId.toString(), assetId: campaign.assetId.toString() };
  });
  return getAssetContent(context.tenantId, context.assetId);
}

export async function getPublicSponsorLogo(tournamentId: string, campaignId: string) {
  if (!validId(tournamentId) || !validId(campaignId)) throw new AppError(404, "PUBLIC_SPONSOR_LOGO_NOT_FOUND", "Sponsor logo was not found");
  const now = new Date();
  const context = await withTransaction(async (session) => {
    const tournament = await Tournament.findOne({ _id: tournamentId, visibility: "PUBLIC" }).select("_id tenantId").session(session);
    if (!tournament) throw new AppError(404, "PUBLIC_SPONSOR_LOGO_NOT_FOUND", "Sponsor logo was not found");
    const campaign = await SponsorCampaign.findOne({ _id: campaignId, tournamentId: tournament._id, tenantId: tournament.tenantId, status: "SCHEDULED", startsAt: { $lte: now }, endsAt: { $gt: now } }).select("sponsorId").session(session);
    if (!campaign) throw new AppError(404, "PUBLIC_SPONSOR_LOGO_NOT_FOUND", "Sponsor logo was not found");
    const sponsor = await Sponsor.findOne({ _id: campaign.sponsorId, tenantId: tournament.tenantId }).select("logoAssetId").session(session);
    if (!sponsor?.logoAssetId) throw new AppError(404, "PUBLIC_SPONSOR_LOGO_NOT_FOUND", "Sponsor logo was not found");
    const asset = await Asset.exists({ _id: sponsor.logoAssetId, tenantId: tournament.tenantId, purpose: "SPONSOR_LOGO", status: "APPROVED", scanStatus: "CLEAN", metadataStripped: true }).session(session);
    if (!asset) throw new AppError(404, "PUBLIC_SPONSOR_LOGO_NOT_FOUND", "Sponsor logo was not found");
    return { tenantId: tournament.tenantId.toString(), assetId: sponsor.logoAssetId.toString() };
  });
  return getAssetContent(context.tenantId, context.assetId);
}
