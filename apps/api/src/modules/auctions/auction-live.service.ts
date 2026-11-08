import { createHash } from "node:crypto";
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { Membership } from "../memberships/models/membership.model.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { PlayerRegistration } from "../registrations/models/player-registration.model.js";
import { RosterEntry } from "../rosters/models/roster-entry.model.js";
import { Team } from "../teams/models/team.model.js";
import { TeamStaff } from "../teams/models/team-staff.model.js";
import { Tournament } from "../tournaments/models/tournament.model.js";
import type { PlaceAuctionBidInput } from "./auction.schemas.js";
import { Auction } from "./models/auction.model.js";
import { AuctionBid } from "./models/auction-bid.model.js";
import { AuctionBidder } from "./models/auction-bidder.model.js";
import { AuctionLot } from "./models/auction-lot.model.js";
import { AuctionResult } from "./models/auction-result.model.js";
import { PurseAccount } from "./models/purse-account.model.js";
import { PurseLedgerEntry } from "./models/purse-ledger-entry.model.js";

const validId = (id: string) => Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);
export type AuctionActor = { type: "USER"; id: string } | { type: "SYSTEM" };
const auctionEventVisibility = (tournament: { visibility: string }) => tournament.visibility === "PUBLIC" ? "PUBLIC" as const : "TENANT_PRIVATE" as const;
const auctionRules = (auction: { rulesSnapshot: unknown }) => auction.rulesSnapshot as {
  purseBudget: number; purseUnitLabel: string; basePrice: number; minimumIncrement: number; lotDurationSeconds: number;
  antiSnipingExtensionSeconds: number; antiSnipingMaxExtensions: number; unsoldPolicy: "CLOSE" | "REOFFER";
  maxUnsoldReoffers: number; minimumSquadSize: number; maximumSquadSize: number;
};

function auctionDto(auction: { _id: Types.ObjectId; tenantId: Types.ObjectId; tournamentId: Types.ObjectId; name: string; slug: string; status: string; rulesSnapshot: Record<string, unknown>; sourceTournamentVersion: number; sourceRulesVersion: number; poolSeed: string | null; poolAlgorithm: string | null; poolGeneratedAt: Date | null; poolSize: number; scheduledAt: Date | null; startedAt: Date | null; pausedAt: Date | null; currentLotId: Types.ObjectId | null; aggregateVersion: number; createdAt: Date }) {
  const rules = Object.fromEntries(Object.entries(auction.rulesSnapshot).filter(([key]) => key !== "purseBudget"));
  return { id: auction._id.toString(), tenantId: auction.tenantId.toString(), tournamentId: auction.tournamentId.toString(), name: auction.name, slug: auction.slug, status: auction.status, rules, sourceTournamentVersion: auction.sourceTournamentVersion, sourceRulesVersion: auction.sourceRulesVersion, poolSeed: auction.poolSeed, poolAlgorithm: auction.poolAlgorithm, poolGeneratedAt: auction.poolGeneratedAt, poolSize: auction.poolSize, scheduledAt: auction.scheduledAt, startedAt: auction.startedAt, pausedAt: auction.pausedAt, currentLotId: auction.currentLotId?.toString() ?? null, version: auction.aggregateVersion, createdAt: auction.createdAt };
}

function lotDto(lot: { _id: Types.ObjectId; auctionId: Types.ObjectId; lotNumber: number; attemptNumber: number; reoffersCount: number; registrationId: Types.ObjectId; playerProfileId: Types.ObjectId; player: Record<string, unknown>; openingPrice: number; currentPrice: number; leadingTeamId: Types.ObjectId | null; status: string; openedAt: Date | null; closesAt: Date | null; bidSequence: number; antiSnipingExtensions: number; aggregateVersion: number }) {
  return { id: lot._id.toString(), auctionId: lot.auctionId.toString(), lotNumber: lot.lotNumber, attemptNumber: lot.attemptNumber, reoffersCount: lot.reoffersCount, registrationId: lot.registrationId.toString(), playerProfileId: lot.playerProfileId.toString(), player: lot.player, openingPrice: lot.openingPrice, currentPrice: lot.currentPrice, leadingTeamId: lot.leadingTeamId?.toString() ?? null, status: lot.status, openedAt: lot.openedAt, closesAt: lot.closesAt, bidSequence: lot.bidSequence, antiSnipingExtensions: lot.antiSnipingExtensions, version: lot.aggregateVersion };
}

function bidDto(bid: { _id: Types.ObjectId; lotId: Types.ObjectId; teamId: Types.ObjectId; bidderId: Types.ObjectId; sequence: number; amount: number; acceptedAt: Date; lotVersionAfter: number }) {
  return { id: bid._id.toString(), lotId: bid.lotId.toString(), teamId: bid.teamId.toString(), bidderId: bid.bidderId.toString(), sequence: bid.sequence, amount: bid.amount, acceptedAt: bid.acceptedAt, lotVersion: bid.lotVersionAfter };
}

function resultDto(result: { _id: Types.ObjectId; auctionId: Types.ObjectId; lotId: Types.ObjectId; attemptNumber: number; outcome: string; winnerTeamId: Types.ObjectId | null; winningBidId: Types.ObjectId | null; finalPrice: number; finalizedAt: Date; finalizedByType: string; aggregateVersion: number }) {
  return { id: result._id.toString(), auctionId: result.auctionId.toString(), lotId: result.lotId.toString(), attemptNumber: result.attemptNumber, outcome: result.outcome, winnerTeamId: result.winnerTeamId?.toString() ?? null, winningBidId: result.winningBidId?.toString() ?? null, finalPrice: result.finalPrice, finalizedAt: result.finalizedAt, finalizedByType: result.finalizedByType ?? "USER", version: result.aggregateVersion };
}

async function assertBidder(tenantId: string, auctionId: string, tournamentId: Types.ObjectId, teamId: string, userId: string, session: ClientSession) {
  // MongoDB does not support parallel operations on the same transaction session.
  const membership = await Membership.findOne({ tenantId, userId, status: "ACTIVE" }).session(session);
  const assignment = await AuctionBidder.findOne({ tenantId, auctionId, teamId, userId, status: "ACTIVE" }).session(session);
  const teamStaff = await TeamStaff.findOne({ tenantId, tournamentId, teamId, userId, status: "ACTIVE", roles: "BIDDER" }).session(session);
  const account = await PurseAccount.findOne({ tenantId, auctionId, teamId }).session(session);
  if (!membership || !assignment || !teamStaff) throw new AppError(403, "BIDDER_NOT_AUTHORIZED", "An active team-scoped auction bidder assignment is required");
  if (!account) throw new AppError(404, "PURSE_ACCOUNT_NOT_FOUND", "Team purse account was not found");
  return account;
}

async function ensureBidderCoverage(tenantId: string, auctionId: string, session: ClientSession) {
  const accounts = await PurseAccount.find({ tenantId, auctionId }).select("teamId").session(session).lean();
  const assignments = await AuctionBidder.find({ tenantId, auctionId, status: "ACTIVE" }).select("teamId userId tournamentId").session(session).lean();
  const activeTeams = new Set<string>();
  for (const assignment of assignments) {
    const membership = await Membership.exists({ tenantId, userId: assignment.userId, status: "ACTIVE" }).session(session);
    const staff = await TeamStaff.exists({ tenantId, tournamentId: assignment.tournamentId, teamId: assignment.teamId, userId: assignment.userId, status: "ACTIVE", roles: "BIDDER" }).session(session);
    if (membership && staff) activeTeams.add(assignment.teamId.toString());
  }
  const missing = accounts.filter((account) => !activeTeams.has(account.teamId.toString()));
  if (accounts.length < 2 || missing.length) throw new AppError(409, "AUCTION_BIDDERS_INCOMPLETE", "Every auction team must have an active authorized bidder before live play", { teamIds: missing.map((account) => account.teamId.toString()) });
}

export async function scheduleAuction(tenantId: string, auctionId: string, actorId: string, requestId: string, expectedAuctionVersion: number, scheduledAtInput: string) {
  if (!validId(auctionId)) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  return withTransaction(async (session: ClientSession) => {
    const auction = await Auction.findOne({ _id: auctionId, tenantId, status: "POOL_APPROVED" }).session(session);
    if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Pool-approved auction was not found");
    if (auction.aggregateVersion !== expectedAuctionVersion) throw new AppError(409, "STALE_AUCTION_VERSION", "Auction changed; reload before retrying", { currentVersion: auction.aggregateVersion });
    const tournament = await Tournament.findOne({ _id: auction.tournamentId, tenantId }).session(session);
    const scheduledAt = new Date(scheduledAtInput);
    if (!tournament || !["REGISTRATION_CLOSED", "SCHEDULED"].includes(tournament.status) || tournament.rulesVersion !== auction.sourceRulesVersion) throw new AppError(409, "AUCTION_TOURNAMENT_CHANGED", "Tournament setup changed after the auction was created");
    if (scheduledAt < new Date() || scheduledAt < tournament.startAt || scheduledAt >= tournament.endAt) throw new AppError(400, "AUCTION_TIME_OUTSIDE_TOURNAMENT", "Auction start must be in the future and inside the tournament date window");
    auction.status = "SCHEDULED";
    auction.scheduledAt = scheduledAt;
    auction.aggregateVersion += 1;
    await auction.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.scheduled", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auction.id, requestId, metadata: { scheduledAt } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "auction.scheduled", schemaVersion: 1, aggregateType: "auction", aggregateId: auction.id, aggregateVersion: auction.aggregateVersion, visibility: auctionEventVisibility(tournament), data: { auctionId: auction.id, tournamentId: auction.tournamentId.toString(), scheduledAt, status: auction.status } }, session);
    return auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]);
  });
}

export async function startAuction(tenantId: string, auctionId: string, actorId: string, requestId: string, expectedAuctionVersion: number) {
  if (!validId(auctionId)) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  return withTransaction(async (session: ClientSession) => {
    const auction = await Auction.findOne({ _id: auctionId, tenantId, status: "SCHEDULED" }).session(session);
    if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Scheduled auction was not found");
    if (auction.aggregateVersion !== expectedAuctionVersion) throw new AppError(409, "STALE_AUCTION_VERSION", "Auction changed; reload before retrying", { currentVersion: auction.aggregateVersion });
    if (!auction.scheduledAt || auction.scheduledAt > new Date()) throw new AppError(409, "AUCTION_NOT_DUE", "Auction cannot start before its scheduled time");
    const tournament = await Tournament.findOne({ _id: auction.tournamentId, tenantId }).select("visibility").session(session);
    if (!tournament) throw new AppError(409, "AUCTION_TOURNAMENT_CHANGED", "Auction tournament was not found");
    await ensureBidderCoverage(tenantId, auctionId, session);
    const now = new Date();
    auction.status = "LIVE";
    auction.startedAt = now;
    auction.aggregateVersion += 1;
    await auction.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.started", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auction.id, requestId, metadata: { startedAt: now } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "auction.started", schemaVersion: 1, aggregateType: "auction", aggregateId: auction.id, aggregateVersion: auction.aggregateVersion, visibility: auctionEventVisibility(tournament), data: { auctionId: auction.id, tournamentId: auction.tournamentId.toString(), startedAt: now, status: auction.status } }, session);
    return auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]);
  });
}

export async function pauseAuction(tenantId: string, auctionId: string, actorId: string, requestId: string, expectedAuctionVersion: number, reason: string) {
  if (!validId(auctionId)) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  return withTransaction(async (session: ClientSession) => {
    const auction = await Auction.findOne({ _id: auctionId, tenantId, status: "LIVE" }).session(session);
    if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Live auction was not found");
    if (auction.aggregateVersion !== expectedAuctionVersion) throw new AppError(409, "STALE_AUCTION_VERSION", "Auction changed; reload before retrying", { currentVersion: auction.aggregateVersion });
    const tournament = await Tournament.findOne({ _id: auction.tournamentId, tenantId }).select("visibility").session(session);
    if (!tournament) throw new AppError(409, "AUCTION_TOURNAMENT_CHANGED", "Auction tournament was not found");
    const now = new Date();
    if (auction.currentLotId) {
      const lot = await AuctionLot.findOne({ _id: auction.currentLotId, tenantId, auctionId, status: "OPEN" }).session(session);
      if (!lot?.closesAt) throw new AppError(409, "AUCTION_CURRENT_LOT_INCONSISTENT", "Auction current lot cannot be paused; operator review is required");
      auction.pausedLotRemainingMs = Math.max(0, lot.closesAt.getTime() - now.getTime());
      lot.status = "PAUSED";
      lot.aggregateVersion += 1;
      await lot.save({ session });
    } else {
      auction.pausedLotRemainingMs = null;
    }
    auction.status = "PAUSED";
    auction.pausedAt = now;
    auction.aggregateVersion += 1;
    await auction.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.paused", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auction.id, requestId, reason, metadata: { pausedAt: now, currentLotId: auction.currentLotId?.toString() ?? null, remainingMs: auction.pausedLotRemainingMs } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "auction.paused", schemaVersion: 1, aggregateType: "auction", aggregateId: auction.id, aggregateVersion: auction.aggregateVersion, visibility: auctionEventVisibility(tournament), data: { auctionId: auction.id, tournamentId: auction.tournamentId.toString(), status: auction.status, pausedAt: now, currentLotId: auction.currentLotId?.toString() ?? null } }, session);
    return auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]);
  });
}

export async function resumeAuction(tenantId: string, auctionId: string, actorId: string, requestId: string, expectedAuctionVersion: number, reason: string) {
  if (!validId(auctionId)) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  return withTransaction(async (session: ClientSession) => {
    const auction = await Auction.findOne({ _id: auctionId, tenantId, status: "PAUSED" }).session(session);
    if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Paused auction was not found");
    if (auction.aggregateVersion !== expectedAuctionVersion) throw new AppError(409, "STALE_AUCTION_VERSION", "Auction changed; reload before retrying", { currentVersion: auction.aggregateVersion });
    const tournament = await Tournament.findOne({ _id: auction.tournamentId, tenantId }).select("visibility").session(session);
    if (!tournament) throw new AppError(409, "AUCTION_TOURNAMENT_CHANGED", "Auction tournament was not found");
    const now = new Date();
    if (auction.currentLotId) {
      const lot = await AuctionLot.findOne({ _id: auction.currentLotId, tenantId, auctionId, status: "PAUSED" }).session(session);
      if (!lot || auction.pausedLotRemainingMs === null || auction.pausedLotRemainingMs === undefined) throw new AppError(409, "AUCTION_CURRENT_LOT_INCONSISTENT", "Paused lot timer is missing; operator review is required");
      lot.status = "OPEN";
      lot.closesAt = new Date(now.getTime() + auction.pausedLotRemainingMs);
      lot.aggregateVersion += 1;
      await lot.save({ session });
    }
    auction.status = "LIVE";
    auction.pausedAt = null;
    auction.pausedLotRemainingMs = null;
    auction.aggregateVersion += 1;
    await auction.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.resumed", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auction.id, requestId, reason, metadata: { resumedAt: now, currentLotId: auction.currentLotId?.toString() ?? null } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "auction.resumed", schemaVersion: 1, aggregateType: "auction", aggregateId: auction.id, aggregateVersion: auction.aggregateVersion, visibility: auctionEventVisibility(tournament), data: { auctionId: auction.id, tournamentId: auction.tournamentId.toString(), status: auction.status, resumedAt: now, currentLotId: auction.currentLotId?.toString() ?? null } }, session);
    return auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]);
  });
}

export async function openNextAuctionLot(tenantId: string, auctionId: string, actor: AuctionActor, requestId: string, expectedAuctionVersion: number) {
  if (!validId(auctionId)) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  return withTransaction(async (session: ClientSession) => {
    const auction = await Auction.findOne({ _id: auctionId, tenantId, status: "LIVE" }).session(session);
    if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Live auction was not found");
    if (auction.currentLotId) {
      const current = await AuctionLot.findOne({ _id: auction.currentLotId, tenantId, auctionId, status: "OPEN" }).session(session);
      if (current) return { auction: auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]), lot: lotDto(current as unknown as Parameters<typeof lotDto>[0]), idempotentReplay: true };
      throw new AppError(409, "AUCTION_CURRENT_LOT_INCONSISTENT", "Auction current lot is not open; operator review is required");
    }
    if (auction.aggregateVersion !== expectedAuctionVersion) throw new AppError(409, "STALE_AUCTION_VERSION", "Auction changed; reload before retrying", { currentVersion: auction.aggregateVersion });
    const tournament = await Tournament.findOne({ _id: auction.tournamentId, tenantId }).select("visibility").session(session);
    if (!tournament) throw new AppError(409, "AUCTION_TOURNAMENT_CHANGED", "Auction tournament was not found");
    let lot = await AuctionLot.findOne({ tenantId, auctionId, status: "QUEUED" }).sort({ lotNumber: 1 }).session(session);
    if (!lot && auctionRules(auction).unsoldPolicy === "REOFFER") {
      const rules = auctionRules(auction);
      const unsold = await AuctionLot.findOne({ tenantId, auctionId, status: "UNSOLD", reoffersCount: { $lt: rules.maxUnsoldReoffers } }).sort({ lotNumber: 1 }).session(session);
      if (unsold) {
        unsold.status = "QUEUED";
        unsold.attemptNumber += 1;
        unsold.reoffersCount += 1;
        unsold.currentPrice = unsold.openingPrice;
        unsold.leadingTeamId = null;
        unsold.currentBidId = null;
        unsold.openedAt = null;
        unsold.closesAt = null;
        unsold.antiSnipingExtensions = 0;
        unsold.aggregateVersion += 1;
        await unsold.save({ session });
        await recordAudit({ actorType: actor.type, ...(actor.type === "USER" ? { actorId: actor.id } : {}), tenantId, action: "auction.lot.reoffered", outcome: "SUCCEEDED", resourceType: "auction_lot", resourceId: unsold.id, requestId, metadata: { auctionId, lotNumber: unsold.lotNumber, attemptNumber: unsold.attemptNumber } }, session);
        await enqueueOutboxEvent({ tenantId, eventType: "auction.lot.reoffered", schemaVersion: 1, aggregateType: "auction_lot", aggregateId: unsold.id, aggregateVersion: unsold.aggregateVersion, visibility: auctionEventVisibility(tournament), data: { auctionId, tournamentId: auction.tournamentId.toString(), lotId: unsold.id, lotNumber: unsold.lotNumber, attemptNumber: unsold.attemptNumber } }, session);
        lot = unsold;
      }
    }
    if (!lot) {
      auction.status = "COMPLETED";
      auction.aggregateVersion += 1;
      await auction.save({ session });
      await recordAudit({ actorType: actor.type, ...(actor.type === "USER" ? { actorId: actor.id } : {}), tenantId, action: "auction.completed", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auction.id, requestId, metadata: { poolSize: auction.poolSize } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "auction.completed", schemaVersion: 1, aggregateType: "auction", aggregateId: auction.id, aggregateVersion: auction.aggregateVersion, visibility: auctionEventVisibility(tournament), data: { auctionId: auction.id, tournamentId: auction.tournamentId.toString(), status: auction.status } }, session);
      return { auction: auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]), lot: null, idempotentReplay: false };
    }
    const now = new Date();
    const rules = auctionRules(auction);
    lot.status = "OPEN";
    lot.openedAt = now;
    lot.closesAt = new Date(now.getTime() + rules.lotDurationSeconds * 1000);
    lot.aggregateVersion += 1;
    await lot.save({ session });
    auction.currentLotId = lot._id;
    auction.aggregateVersion += 1;
    await auction.save({ session });
    await recordAudit({ actorType: actor.type, ...(actor.type === "USER" ? { actorId: actor.id } : {}), tenantId, action: "auction.lot.opened", outcome: "SUCCEEDED", resourceType: "auction_lot", resourceId: lot.id, requestId, metadata: { auctionId, lotNumber: lot.lotNumber, attemptNumber: lot.attemptNumber, closesAt: lot.closesAt } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "auction.lot.opened", schemaVersion: 1, aggregateType: "auction_lot", aggregateId: lot.id, aggregateVersion: lot.aggregateVersion, visibility: auctionEventVisibility(tournament), data: { auctionId, tournamentId: auction.tournamentId.toString(), lotId: lot.id, lotNumber: lot.lotNumber, attemptNumber: lot.attemptNumber, closesAt: lot.closesAt } }, session);
    return { auction: auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]), lot: lotDto(lot as unknown as Parameters<typeof lotDto>[0]), idempotentReplay: false };
  });
}

export async function placeAuctionBid(tenantId: string, auctionId: string, lotId: string, bidderId: string, requestId: string, input: PlaceAuctionBidInput) {
  if (!validId(auctionId) || !validId(lotId) || !validId(input.teamId)) throw new AppError(404, "AUCTION_LOT_OR_TEAM_NOT_FOUND", "Auction, lot or team was not found");
  const intentHash = createHash("sha256").update(`${lotId}:${input.teamId}:${input.amount}:${input.expectedLotVersion}`).digest("hex");
  try {
    return await withTransaction(async (session: ClientSession) => {
      const auction = await Auction.findOne({ _id: auctionId, tenantId }).session(session);
      if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
      const tournament = await Tournament.findOne({ _id: auction.tournamentId, tenantId }).select("visibility").session(session);
      if (!tournament) throw new AppError(409, "AUCTION_TOURNAMENT_CHANGED", "Auction tournament was not found");
      const account = await assertBidder(tenantId, auctionId, auction.tournamentId, input.teamId, bidderId, session);
      const priorBid = await AuctionBid.findOne({ tenantId, auctionId, bidderId, idempotencyKey: input.idempotencyKey }).session(session);
      if (priorBid) {
        if (priorBid.intentHash !== intentHash) throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different bid");
        const currentLot = await AuctionLot.findOne({ _id: lotId, tenantId, auctionId }).session(session);
        return { bid: bidDto(priorBid as unknown as Parameters<typeof bidDto>[0]), lot: currentLot ? lotDto(currentLot as unknown as Parameters<typeof lotDto>[0]) : null, idempotentReplay: true };
      }
      if (auction.status !== "LIVE" || !auction.currentLotId?.equals(lotId)) throw new AppError(409, "LOT_NOT_CURRENT", "Bids are accepted only on the auction's currently open lot");
      const lot = await AuctionLot.findOne({ _id: lotId, tenantId, auctionId, status: "OPEN" }).session(session);
      if (!lot) throw new AppError(409, "LOT_NOT_OPEN", "This auction lot is not open for bidding");
      if (lot.aggregateVersion !== input.expectedLotVersion) throw new AppError(409, "STALE_LOT_VERSION", "Lot changed; reload before bidding", { currentVersion: lot.aggregateVersion, currentPrice: lot.currentPrice });
      const now = new Date();
      if (!lot.closesAt || lot.closesAt <= now) throw new AppError(409, "LOT_BIDDING_CLOSED", "The lot bidding window has closed");
      const rules = auctionRules(auction);
      const minimumBid = lot.leadingTeamId ? lot.currentPrice + rules.minimumIncrement : lot.openingPrice;
      if (input.amount < minimumBid) throw new AppError(409, "BID_BELOW_MINIMUM", "Bid does not meet the required minimum", { minimumBid, currentPrice: lot.currentPrice, currentVersion: lot.aggregateVersion });
      const priorLeaderId = lot.leadingTeamId?.toString() ?? null;
      const newLeaderIsPrior = priorLeaderId === input.teamId;
      let priorLeaderAccount = null;
      if (priorLeaderId && !newLeaderIsPrior) {
        priorLeaderAccount = await PurseAccount.findOne({ tenantId, auctionId, teamId: priorLeaderId }).session(session);
        if (!priorLeaderAccount || priorLeaderAccount.reservedAmount < lot.currentPrice) throw new AppError(409, "PURSE_RESERVATION_INCONSISTENT", "Prior bid reservation requires operator review");
      }
      const newTeamAccount = newLeaderIsPrior ? priorLeaderAccount : account;
      const actualNewAccount = newTeamAccount ?? account;
      if (actualNewAccount.playersAcquired >= rules.maximumSquadSize) throw new AppError(409, "SQUAD_LIMIT_REACHED", "This team has no remaining squad slots");
      const reservationDelta = newLeaderIsPrior ? input.amount - lot.currentPrice : input.amount;
      const availableBefore = actualNewAccount.budget - actualNewAccount.reservedAmount - actualNewAccount.committedAmount;
      if (availableBefore < reservationDelta) throw new AppError(409, "INSUFFICIENT_PURSE", "This bid exceeds the team's available purse");
      const availableAfter = availableBefore - reservationDelta;
      const minimumSlotsAfterWin = Math.max(0, rules.minimumSquadSize - (actualNewAccount.playersAcquired + 1));
      if (availableAfter < minimumSlotsAfterWin * rules.basePrice) throw new AppError(409, "MINIMUM_SQUAD_RESERVE_REQUIRED", "This bid would leave too little purse to fill the minimum squad");
      const nextSequence = lot.bidSequence + 1;
      const nextLotVersion = lot.aggregateVersion + 1;
      const [bid] = await AuctionBid.create([{
        tenantId, tournamentId: auction.tournamentId, auctionId, lotId, teamId: input.teamId, bidderId,
        sequence: nextSequence, amount: input.amount, idempotencyKey: input.idempotencyKey, intentHash,
        expectedLotVersion: input.expectedLotVersion, lotVersionAfter: nextLotVersion, acceptedAt: now,
      }], { session });
      if (!bid) throw new Error("Auction bid creation returned no record");
      if (priorLeaderAccount) {
        priorLeaderAccount.reservedAmount -= lot.currentPrice;
        priorLeaderAccount.aggregateVersion += 1;
        priorLeaderAccount.ledgerSequence += 1;
        await priorLeaderAccount.save({ session });
        await PurseLedgerEntry.create([{
          tenantId, tournamentId: auction.tournamentId, auctionId, purseAccountId: priorLeaderAccount._id, teamId: priorLeaderAccount.teamId,
          sequence: priorLeaderAccount.ledgerSequence, entryType: "BID_RELEASED", amount: lot.currentPrice,
          reservedDelta: -lot.currentPrice, committedDelta: 0, resultingReserved: priorLeaderAccount.reservedAmount,
          resultingCommitted: priorLeaderAccount.committedAmount, referenceId: lot.currentBidId, actorId: bidderId,
        }], { session });
      }
      actualNewAccount.reservedAmount += reservationDelta;
      actualNewAccount.aggregateVersion += 1;
      actualNewAccount.ledgerSequence += 1;
      await actualNewAccount.save({ session });
      await PurseLedgerEntry.create([{
        tenantId, tournamentId: auction.tournamentId, auctionId, purseAccountId: actualNewAccount._id, teamId: actualNewAccount.teamId,
        sequence: actualNewAccount.ledgerSequence, entryType: newLeaderIsPrior ? "BID_REPLACED" : "BID_RESERVED", amount: reservationDelta,
        reservedDelta: reservationDelta, committedDelta: 0, resultingReserved: actualNewAccount.reservedAmount,
        resultingCommitted: actualNewAccount.committedAmount, referenceId: bid._id, actorId: bidderId,
      }], { session });
      lot.bidSequence = nextSequence;
      lot.currentPrice = input.amount;
      lot.leadingTeamId = new Types.ObjectId(input.teamId);
      lot.currentBidId = bid._id;
      lot.aggregateVersion = nextLotVersion;
      const extensionSeconds = rules.antiSnipingExtensionSeconds;
      if (extensionSeconds > 0 && lot.antiSnipingExtensions < rules.antiSnipingMaxExtensions && lot.closesAt.getTime() - now.getTime() <= extensionSeconds * 1000) {
        lot.closesAt = new Date(lot.closesAt.getTime() + extensionSeconds * 1000);
        lot.antiSnipingExtensions += 1;
      }
      await lot.save({ session });
      await recordAudit({ actorType: "USER", actorId: bidderId, tenantId, action: "auction.bid.accepted", outcome: "SUCCEEDED", resourceType: "auction_lot", resourceId: lot.id, requestId, metadata: { bidId: bid.id, teamId: input.teamId, sequence: bid.sequence, amount: bid.amount, lotVersion: lot.aggregateVersion } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "auction.bid.accepted", schemaVersion: 1, aggregateType: "auction_lot", aggregateId: lot.id, aggregateVersion: lot.aggregateVersion, visibility: auctionEventVisibility(tournament), data: { auctionId, tournamentId: auction.tournamentId.toString(), lotId, bidId: bid.id, lotNumber: lot.lotNumber, sequence: bid.sequence, teamId: input.teamId, amount: input.amount, closesAt: lot.closesAt } }, session);
      return { bid: bidDto(bid as unknown as Parameters<typeof bidDto>[0]), lot: lotDto(lot as unknown as Parameters<typeof lotDto>[0]), idempotentReplay: false };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      const prior = await AuctionBid.findOne({ tenantId, auctionId, bidderId, idempotencyKey: input.idempotencyKey }).lean();
      if (prior) {
        if (prior.intentHash !== intentHash) throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different bid");
        const currentLot = await AuctionLot.findOne({ _id: lotId, tenantId, auctionId }).lean();
        return { bid: bidDto(prior as unknown as Parameters<typeof bidDto>[0]), lot: currentLot ? lotDto(currentLot as unknown as Parameters<typeof lotDto>[0]) : null, idempotentReplay: true };
      }
      throw new AppError(409, "BID_CONFLICT", "Another bid changed the lot; reload and retry with a new idempotency key");
    }
    throw error;
  }
}

export async function finalizeAuctionLot(tenantId: string, auctionId: string, lotId: string, actor: AuctionActor, requestId: string, expectedLotVersion: number) {
  if (!validId(auctionId) || !validId(lotId)) throw new AppError(404, "AUCTION_LOT_NOT_FOUND", "Auction lot was not found");
  try {
    return await withTransaction(async (session: ClientSession) => {
      const auction = await Auction.findOne({ _id: auctionId, tenantId }).session(session);
      if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
      const priorResult = await AuctionResult.findOne({ tenantId, auctionId, lotId, lotVersionAtFinalization: expectedLotVersion }).session(session);
      if (priorResult) return { result: resultDto(priorResult as unknown as Parameters<typeof resultDto>[0]), idempotentReplay: true };
      if (auction.status !== "LIVE" || !auction.currentLotId?.equals(lotId)) throw new AppError(409, "LOT_NOT_CURRENT", "Only the currently open auction lot can be finalized");
      const lot = await AuctionLot.findOne({ _id: lotId, tenantId, auctionId, status: "OPEN" }).session(session);
      if (!lot) throw new AppError(404, "AUCTION_LOT_NOT_FOUND", "Open auction lot was not found");
      if (lot.aggregateVersion !== expectedLotVersion) throw new AppError(409, "STALE_LOT_VERSION", "Lot changed; reload before finalizing", { currentVersion: lot.aggregateVersion });
      const tournament = await Tournament.findOne({ _id: auction.tournamentId, tenantId }).session(session);
      if (!tournament) throw new AppError(409, "SETTLEMENT_TARGET_MISSING", "Tournament requires operator review");
      const now = new Date();
      if (!lot.closesAt || lot.closesAt > now) throw new AppError(409, "LOT_TIMER_ACTIVE", "Lot cannot be finalized before its bidding window closes");
      const sold = Boolean(lot.leadingTeamId && lot.currentBidId);
      const rules = auctionRules(auction);
      let account = null;
      let rosterEntry = null;
      let team = null;
      let registration = null;
      if (sold && lot.leadingTeamId && lot.currentBidId) {
        account = await PurseAccount.findOne({ tenantId, auctionId, teamId: lot.leadingTeamId }).session(session);
        if (!account || account.reservedAmount < lot.currentPrice || account.playersAcquired >= rules.maximumSquadSize || account.committedAmount + lot.currentPrice > account.budget) throw new AppError(409, "SETTLEMENT_INVARIANT_FAILED", "Purse or squad state requires operator review");
        const remainingSlots = Math.max(0, rules.minimumSquadSize - (account.playersAcquired + 1));
        const availableAfterCommit = account.budget - account.committedAmount - account.reservedAmount;
        if (availableAfterCommit < remainingSlots * rules.basePrice) throw new AppError(409, "MINIMUM_SQUAD_RESERVE_REQUIRED", "Winning this lot would violate the minimum squad reserve");
        registration = await PlayerRegistration.findOne({ _id: lot.registrationId, tenantId, tournamentId: auction.tournamentId, status: "APPROVED" }).session(session);
        if (!registration || !registration.playerProfileId.equals(lot.playerProfileId)) throw new AppError(409, "APPROVED_REGISTRATION_REQUIRED", "Lot registration is no longer eligible for roster assignment");
        const existing = await RosterEntry.findOne({ tenantId, tournamentId: auction.tournamentId, playerProfileId: lot.playerProfileId }).session(session);
        if (existing?.status === "ACTIVE") throw new AppError(409, "PLAYER_ALREADY_ROSTERED", "Player already has an active tournament roster; settlement requires operator review");
        team = await Team.findOne({ _id: lot.leadingTeamId, tenantId, tournamentId: auction.tournamentId, status: "ACTIVE" }).session(session);
        if (!team) throw new AppError(409, "SETTLEMENT_TARGET_MISSING", "Winning team requires operator review");
        if (existing) {
          const previousTeamId = existing.teamId;
          existing.teamId = lot.leadingTeamId;
          existing.registrationId = registration._id;
          existing.source = "AUCTION_RESULT";
          existing.status = "ACTIVE";
          existing.assignedAt = now;
          existing.releasedAt = null;
          existing.aggregateVersion += 1;
          existing.history.push({ action: previousTeamId.equals(lot.leadingTeamId) ? "ASSIGNED" : "TRANSFERRED", fromTeamId: previousTeamId, toTeamId: lot.leadingTeamId, actorType: actor.type, actorId: actor.type === "USER" ? new Types.ObjectId(actor.id) : null, reason: `Auction lot ${lot.lotNumber} won`, occurredAt: now });
          await existing.save({ session });
          rosterEntry = existing;
        } else {
          const [createdEntry] = await RosterEntry.create([{
            tenantId, tournamentId: auction.tournamentId, teamId: lot.leadingTeamId, playerProfileId: lot.playerProfileId,
            registrationId: registration._id, source: "AUCTION_RESULT", status: "ACTIVE", assignedAt: now, aggregateVersion: 1,
            history: [{ action: "ASSIGNED", fromTeamId: null, toTeamId: lot.leadingTeamId, actorType: actor.type, actorId: actor.type === "USER" ? actor.id : null, reason: `Auction lot ${lot.lotNumber} won`, occurredAt: now }],
          }], { session });
          if (!createdEntry) throw new Error("Auction result roster entry creation returned no record");
          rosterEntry = createdEntry;
        }
      }
      const [result] = await AuctionResult.create([{
        tenantId, tournamentId: auction.tournamentId, auctionId, lotId, attemptNumber: lot.attemptNumber,
        lotVersionAtFinalization: lot.aggregateVersion, outcome: sold ? "SOLD" : "UNSOLD",
        winnerTeamId: sold ? lot.leadingTeamId : null, winningBidId: sold ? lot.currentBidId : null,
        finalPrice: sold ? lot.currentPrice : 0, finalizedByType: actor.type, finalizedById: actor.type === "USER" ? actor.id : null, finalizedAt: now, aggregateVersion: 1,
      }], { session });
      if (!result) throw new Error("Auction result creation returned no record");
      if (sold && account && rosterEntry && team && tournament) {
        account.reservedAmount -= lot.currentPrice;
        account.committedAmount += lot.currentPrice;
        account.playersAcquired += 1;
        account.aggregateVersion += 1;
        account.ledgerSequence += 1;
        await account.save({ session });
        await PurseLedgerEntry.create([{
          tenantId, tournamentId: auction.tournamentId, auctionId, purseAccountId: account._id, teamId: account.teamId,
          sequence: account.ledgerSequence, entryType: "BID_COMMITTED", amount: lot.currentPrice,
          reservedDelta: -lot.currentPrice, committedDelta: lot.currentPrice, resultingReserved: account.reservedAmount,
          resultingCommitted: account.committedAmount, referenceId: result._id, actorType: actor.type, actorId: actor.type === "USER" ? actor.id : null,
        }], { session });
        team.aggregateVersion += 1;
        tournament.aggregateVersion += 1;
        await team.save({ session });
        await tournament.save({ session });
        await recordAudit({ actorType: actor.type, ...(actor.type === "USER" ? { actorId: actor.id } : {}), tenantId, action: "team.roster.auction_assigned", outcome: "SUCCEEDED", resourceType: "roster_entry", resourceId: rosterEntry.id, requestId, metadata: { auctionId, lotId, teamId: team.id, playerProfileId: lot.playerProfileId.toString(), resultId: result.id } }, session);
        await enqueueOutboxEvent({ tenantId, eventType: "team.roster.auction_assigned", schemaVersion: 1, aggregateType: "roster_entry", aggregateId: rosterEntry.id, aggregateVersion: rosterEntry.aggregateVersion, visibility: "TENANT_PRIVATE", data: { auctionId, lotId, teamId: team.id, playerProfileId: lot.playerProfileId.toString(), resultId: result.id, source: "AUCTION_RESULT" } }, session);
      }
      lot.status = sold ? "SOLD" : "UNSOLD";
      lot.aggregateVersion += 1;
      await lot.save({ session });
      auction.currentLotId = null;
      auction.aggregateVersion += 1;
      await auction.save({ session });
      await recordAudit({ actorType: actor.type, ...(actor.type === "USER" ? { actorId: actor.id } : {}), tenantId, action: sold ? "auction.lot.sold" : "auction.lot.unsold", outcome: "SUCCEEDED", resourceType: "auction_lot", resourceId: lot.id, requestId, metadata: { auctionId, attemptNumber: lot.attemptNumber, winningTeamId: sold ? lot.leadingTeamId?.toString() : null, finalPrice: result.finalPrice, resultId: result.id } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: sold ? "auction.lot.sold" : "auction.lot.unsold", schemaVersion: 1, aggregateType: "auction_lot", aggregateId: lot.id, aggregateVersion: lot.aggregateVersion, visibility: auctionEventVisibility(tournament), data: { auctionId, tournamentId: auction.tournamentId.toString(), lotId, lotNumber: lot.lotNumber, attemptNumber: lot.attemptNumber, outcome: result.outcome, winnerTeamId: result.winnerTeamId?.toString() ?? null, finalPrice: result.finalPrice, resultId: result.id } }, session);
      return { result: resultDto(result as unknown as Parameters<typeof resultDto>[0]), idempotentReplay: false };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      const prior = await AuctionResult.findOne({ tenantId, auctionId, lotId, lotVersionAtFinalization: expectedLotVersion }).lean();
      if (prior) return { result: resultDto(prior as unknown as Parameters<typeof resultDto>[0]), idempotentReplay: true };
      throw new AppError(409, "AUCTION_SETTLEMENT_CONFLICT", "Auction settlement conflicted with another update; reload the lot");
    }
    throw error;
  }
}
