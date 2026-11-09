import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { z } from "zod";
import { env } from "../../platform/config/env.js";
import { AppError } from "../../platform/errors/app-error.js";
import { Asset } from "../assets/models/asset.model.js";
import { Invitation } from "../memberships/models/invitation.model.js";
import { Membership } from "../memberships/models/membership.model.js";
import { PlayerRegistration } from "../registrations/models/player-registration.model.js";
import { SponsorCampaign } from "../sponsors/models/sponsor-campaign.model.js";
import { Team } from "../teams/models/team.model.js";
import { Tournament } from "../tournaments/models/tournament.model.js";
import { TenantSubscription } from "../subscriptions/models/tenant-subscription.model.js";
import { UsageCounter } from "./models/usage-counter.model.js";
import { UsageEvent } from "./models/usage-event.model.js";

export const quotaMetricSchema = z.enum([
  "activeTournaments", "activeMembers", "teamsPerTournament", "registrationsPerTournament",
  "assetStorageBytes", "sponsorCampaignsPerTournament", "monthlyApiRequests", "monthlyExports",
  "realtimeConnections", "monthlyPublicSpectators",
]);
export type QuotaMetric = z.infer<typeof quotaMetricSchema>;

const usageEventInputSchema = z.object({
  tenantId: z.string().regex(/^[a-f\d]{24}$/i),
  eventId: z.string().min(1).max(120),
  metric: z.enum(["monthlyApiRequests", "monthlyExports", "monthlyPublicSpectators"]),
  quantity: z.number().int().positive().max(1_000_000),
  periodStart: z.date(),
  periodEnd: z.date(),
  occurredAt: z.date().default(() => new Date()),
  sourceType: z.string().min(1).max(80),
  sourceId: z.string().min(1).max(160),
  dimensions: z.record(z.string().max(80), z.union([z.string().max(160), z.number(), z.boolean()])).default({}),
}).strict().superRefine((event, context) => {
  if (event.periodStart >= event.periodEnd) context.addIssue({ code: "custom", message: "Usage period end must be after its start", path: ["periodEnd"] });
  const sensitiveDimension = /(email|phone|address|birth|dob|document|contact|token|secret|password)/i;
  for (const key of Object.keys(event.dimensions)) {
    if (sensitiveDimension.test(key)) context.addIssue({ code: "custom", message: "Usage dimensions cannot contain personal or secret fields", path: ["dimensions", key] });
  }
});

type UsageReader = (session: ClientSession) => Promise<number>;

export async function assertWithinQuota(tenantId: string, metric: QuotaMetric, session: ClientSession, readUsed: UsageReader, requested = 1) {
  if (!Number.isSafeInteger(requested) || requested < 0) throw new AppError(400, "QUOTA_REQUEST_INVALID", "Requested usage quantity is invalid");
  const subscription = await TenantSubscription.findOne({ tenantId }).select("status limitsSnapshot +quotaGuardVersion").session(session);
  if (!subscription || subscription.status === "UNCONFIGURED") {
    if (env.NODE_ENV === "production") throw new AppError(503, "SUBSCRIPTION_NOT_CONFIGURED", "Organization limits are not configured on this server");
    return;
  }
  const limits = subscription.limitsSnapshot as Record<string, unknown> | null;
  if (!limits || limits[metric] === undefined) throw new AppError(503, "SUBSCRIPTION_LIMIT_NOT_CONFIGURED", "A required organization limit is missing from the assigned plan");
  if (limits[metric] === null) return;
  const limit = limits[metric];
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0) throw new AppError(503, "SUBSCRIPTION_LIMIT_INVALID", "A configured organization limit is invalid");
  // Serialize commands that consume the same tenant quota before reading current usage.
  subscription.quotaGuardVersion += 1;
  await subscription.save({ session });
  const used = await readUsed(session);
  if (!Number.isSafeInteger(used) || used < 0) throw new AppError(503, "USAGE_VALUE_INVALID", "Current organization usage could not be calculated");
  if (!Number.isSafeInteger(used + requested)) throw new AppError(503, "USAGE_VALUE_INVALID", "Projected organization usage is outside supported limits");
  if (used + requested > limit) throw new AppError(409, "QUOTA_EXCEEDED", "This action would exceed the organization's plan limit", { metric, used, requested, limit });
}

export async function recordUsageEvent(input: z.input<typeof usageEventInputSchema>, session: ClientSession) {
  const event = usageEventInputSchema.parse(input);
  const prior = await UsageEvent.findOne({ tenantId: event.tenantId, eventId: event.eventId }).session(session);
  if (prior) {
    if (prior.metric !== event.metric || prior.quantity !== event.quantity || prior.sourceType !== event.sourceType || prior.sourceId !== event.sourceId
      || prior.periodStart.getTime() !== event.periodStart.getTime() || prior.periodEnd.getTime() !== event.periodEnd.getTime()
      || JSON.stringify(prior.dimensions) !== JSON.stringify(event.dimensions)) {
      throw new AppError(409, "USAGE_IDEMPOTENCY_MISMATCH", "The usage event ID was already used with different data");
    }
    return { duplicate: true, quantity: prior.quantity };
  }
  await assertWithinQuota(event.tenantId, event.metric, session, async (activeSession) => {
    const counter = await UsageCounter.findOne({ tenantId: event.tenantId, metric: event.metric, periodStart: event.periodStart }).session(activeSession);
    if (counter && counter.periodEnd.getTime() !== event.periodEnd.getTime()) throw new AppError(409, "USAGE_PERIOD_MISMATCH", "Usage events for a period must use the same period end");
    return counter?.quantity ?? 0;
  }, event.quantity);
  await UsageEvent.create([event], { session });
  const counter = await UsageCounter.findOneAndUpdate({ tenantId: event.tenantId, metric: event.metric, periodStart: event.periodStart }, {
    $setOnInsert: { periodEnd: event.periodEnd, quantity: 0, aggregateVersion: 0 }, $inc: { quantity: event.quantity, aggregateVersion: 1 },
  }, { new: true, upsert: true, session });
  if (!counter) throw new Error("Usage counter update returned no record");
  return { duplicate: false, quantity: counter.quantity };
}

async function sumStorageBytes(tenantId: string, session?: ClientSession) {
  const now = new Date();
  const rows = await Asset.aggregate<{ total: number }>([
    { $match: { tenantId: new Types.ObjectId(tenantId), status: { $nin: ["REJECTED", "DELETED"] } } },
    { $group: { _id: null, total: { $sum: { $cond: [
      { $or: [
        { $and: [{ $eq: ["$status", "PENDING_UPLOAD"] }, { $gt: ["$uploadExpiresAt", now] }] },
        { $and: [{ $eq: ["$status", "UPLOADING"] }, { $gt: ["$uploadClaimExpiresAt", now] }] },
      ] },
      { $ifNull: ["$expectedSizeBytes", env.ASSET_MAX_UPLOAD_BYTES] },
      { $ifNull: ["$sizeBytes", 0] },
    ] } } } },
  ]).session(session ?? null);
  return rows[0]?.total ?? 0;
}

export async function assertAssetStorageQuota(tenantId: string, requestedBytes: number, session: ClientSession) {
  return assertWithinQuota(tenantId, "assetStorageBytes", session, () => sumStorageBytes(tenantId, session), requestedBytes);
}

export async function getTenantUsage(tenantId: string) {
  if (!Types.ObjectId.isValid(tenantId) || !/^[a-f\d]{24}$/i.test(tenantId)) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
  const tenantObjectId = new Types.ObjectId(tenantId);
  const snapshotAt = new Date();
  const [subscription, activeTournaments, activeMembers, pendingInvitations, teamRows, registrationRows, campaignRows, assetStorageBytes, counters] = await Promise.all([
    TenantSubscription.findOne({ tenantId }).lean(),
    Tournament.countDocuments({ tenantId, status: { $in: ["DRAFT", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "SCHEDULED", "LIVE"] } }),
    Membership.countDocuments({ tenantId, status: "ACTIVE" }),
    Invitation.countDocuments({ tenantId, status: "PENDING", expiresAt: { $gt: snapshotAt } }),
    Team.aggregate<{ _id: Types.ObjectId; used: number }>([{ $match: { tenantId: tenantObjectId, status: "ACTIVE" } }, { $group: { _id: "$tournamentId", used: { $sum: 1 } } }]),
    PlayerRegistration.aggregate<{ _id: Types.ObjectId; used: number }>([{ $match: { tenantId: tenantObjectId } }, { $group: { _id: "$tournamentId", used: { $sum: 1 } } }]),
    SponsorCampaign.aggregate<{ _id: Types.ObjectId; used: number }>([{ $match: { tenantId: tenantObjectId, status: { $in: ["SCHEDULED", "PAUSED"] } } }, { $group: { _id: "$tournamentId", used: { $sum: 1 } } }]),
    sumStorageBytes(tenantId),
    UsageCounter.find({ tenantId, periodStart: { $lte: snapshotAt }, periodEnd: { $gt: snapshotAt } }).sort({ periodStart: -1 }).lean(),
  ]);
  const limits = (subscription?.limitsSnapshot ?? {}) as Record<string, number | null>;
  const perTournament = (rows: Array<{ _id: Types.ObjectId; used: number }>, metric: string) => rows.map((row) => ({ tournamentId: row._id.toString(), used: row.used, limit: limits[metric] ?? null, limitConfigured: Object.hasOwn(limits, metric) }));
  return {
    subscriptionStatus: subscription?.status ?? "UNCONFIGURED",
    snapshotAt,
    resources: {
      activeTournaments: { used: activeTournaments, limit: limits.activeTournaments ?? null, limitConfigured: Object.hasOwn(limits, "activeTournaments") },
      activeMembersAndInvitations: { used: activeMembers + pendingInvitations, activeMembers, pendingInvitations, limit: limits.activeMembers ?? null, limitConfigured: Object.hasOwn(limits, "activeMembers") },
      teamsPerTournament: perTournament(teamRows, "teamsPerTournament"),
      registrationsPerTournament: perTournament(registrationRows, "registrationsPerTournament"),
      assetStorageBytes: { used: assetStorageBytes, limit: limits.assetStorageBytes ?? null, limitConfigured: Object.hasOwn(limits, "assetStorageBytes") },
      sponsorCampaignsPerTournament: perTournament(campaignRows, "sponsorCampaignsPerTournament"),
    },
    metered: counters.map((counter) => ({ metric: counter.metric, quantity: counter.quantity, periodStart: counter.periodStart, periodEnd: counter.periodEnd, limit: limits[counter.metric] ?? null, limitConfigured: Object.hasOwn(limits, counter.metric) })),
    notInstrumented: ["monthlyApiRequests", "monthlyExports", "monthlyPublicSpectators", "realtimeConnections"],
  };
}
