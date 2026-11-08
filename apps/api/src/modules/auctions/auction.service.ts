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
import type { AssignAuctionBidderInput, CreateAuctionInput, GenerateAuctionPoolInput } from "./auction.schemas.js";
import { Auction } from "./models/auction.model.js";
import { AuctionBidder } from "./models/auction-bidder.model.js";
import { AuctionLot } from "./models/auction-lot.model.js";
import { PurseAccount } from "./models/purse-account.model.js";
import { PurseLedgerEntry } from "./models/purse-ledger-entry.model.js";

const poolAlgorithm = "fisher-yates-sha256-v1";
const validId = (id: string) => Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);
const auctionDto = (auction: { _id: Types.ObjectId; tenantId: Types.ObjectId; tournamentId: Types.ObjectId; name: string; slug: string; status: string; rulesSnapshot: Record<string, unknown>; sourceTournamentVersion: number; sourceRulesVersion: number; poolSeed: string | null; poolAlgorithm: string | null; poolGeneratedAt: Date | null; poolSize: number; scheduledAt: Date | null; startedAt: Date | null; pausedAt: Date | null; currentLotId: Types.ObjectId | null; aggregateVersion: number; createdAt: Date }) => {
  const publicRules = Object.fromEntries(Object.entries(auction.rulesSnapshot).filter(([key]) => key !== "purseBudget"));
  return { id: auction._id.toString(), tenantId: auction.tenantId.toString(), tournamentId: auction.tournamentId.toString(), name: auction.name, slug: auction.slug, status: auction.status, rules: publicRules, sourceTournamentVersion: auction.sourceTournamentVersion, sourceRulesVersion: auction.sourceRulesVersion, poolSeed: auction.poolSeed, poolAlgorithm: auction.poolAlgorithm, poolGeneratedAt: auction.poolGeneratedAt, poolSize: auction.poolSize, scheduledAt: auction.scheduledAt, startedAt: auction.startedAt, pausedAt: auction.pausedAt, currentLotId: auction.currentLotId?.toString() ?? null, version: auction.aggregateVersion, createdAt: auction.createdAt };
};
type RegistrationRow = { _id: Types.ObjectId; playerProfileId: Types.ObjectId; profileSnapshot: Record<string, unknown>; appliedAt: Date };

function deterministicShuffle<T>(rows: T[], seed: string): T[] {
  let counter = 0;
  const random = () => createHash("sha256").update(`${seed}\0${counter++}`).digest().readUInt32BE(0);
  for (let index = rows.length - 1; index > 0; index -= 1) {
    const swap = random() % (index + 1);
    [rows[index], rows[swap]] = [rows[swap]!, rows[index]!];
  }
  return rows;
}

function purseDto(account: { _id: Types.ObjectId; auctionId: Types.ObjectId; teamId: Types.ObjectId; budget: number; reservedAmount: number; committedAmount: number; playersAcquired: number; aggregateVersion: number }, rules: { purseUnitLabel: string; maximumSquadSize: number }) {
  return { id: account._id.toString(), auctionId: account.auctionId.toString(), teamId: account.teamId.toString(), budget: account.budget, reserved: account.reservedAmount, committed: account.committedAmount, available: account.budget - account.reservedAmount - account.committedAmount, playersAcquired: account.playersAcquired, remainingSlots: Math.max(0, rules.maximumSquadSize - account.playersAcquired), unit: rules.purseUnitLabel, version: account.aggregateVersion };
}

function lotDto(lot: { _id: Types.ObjectId; auctionId: Types.ObjectId; lotNumber: number; attemptNumber: number; reoffersCount: number; registrationId: Types.ObjectId; playerProfileId: Types.ObjectId; player: Record<string, unknown>; openingPrice: number; currentPrice: number; leadingTeamId: Types.ObjectId | null; status: string; openedAt: Date | null; closesAt: Date | null; bidSequence: number; antiSnipingExtensions: number; aggregateVersion: number }) {
  return { id: lot._id.toString(), auctionId: lot.auctionId.toString(), lotNumber: lot.lotNumber, attemptNumber: lot.attemptNumber, reoffersCount: lot.reoffersCount, registrationId: lot.registrationId.toString(), playerProfileId: lot.playerProfileId.toString(), player: lot.player, openingPrice: lot.openingPrice, currentPrice: lot.currentPrice, leadingTeamId: lot.leadingTeamId?.toString() ?? null, status: lot.status, openedAt: lot.openedAt, closesAt: lot.closesAt, bidSequence: lot.bidSequence, antiSnipingExtensions: lot.antiSnipingExtensions, version: lot.aggregateVersion };
}

export async function createAuction(tenantId: string, tournamentId: string, actorId: string, requestId: string, input: CreateAuctionInput) {
  if (!validId(tournamentId)) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  try {
    return await withTransaction(async (session: ClientSession) => {
      const tournament = await Tournament.findOne({ _id: tournamentId, tenantId }).session(session);
      if (!tournament) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
      if (tournament.aggregateVersion !== input.expectedTournamentVersion) throw new AppError(409, "STALE_TOURNAMENT_VERSION", "Tournament changed; reload before retrying", { currentVersion: tournament.aggregateVersion });
      if (!["REGISTRATION_CLOSED", "SCHEDULED"].includes(tournament.status)) throw new AppError(409, "AUCTION_SETUP_LOCKED", "Create the auction after player registration closes and before live play");
      const teams = await Team.find({ tenantId, tournamentId, status: "ACTIVE" }).select("_id name slug").sort({ slug: 1, _id: 1 }).session(session).lean();
      if (teams.length < 2) throw new AppError(409, "INSUFFICIENT_TEAMS", "At least two active tournament teams are required for an auction");
      const rules = tournament.rules as { minimumSquadSize?: number; maximumSquadSize?: number };
      const minimumSquadSize = Number(rules.minimumSquadSize ?? 1);
      const maximumSquadSize = Number(rules.maximumSquadSize ?? 30);
      const rosterCounts = await RosterEntry.aggregate([{ $match: { tenantId: new Types.ObjectId(tenantId), tournamentId: new Types.ObjectId(tournamentId), status: "ACTIVE" } }, { $group: { _id: "$teamId", rosterSize: { $sum: 1 } } }]).session(session);
      const countByTeam = new Map<string, number>(rosterCounts.map((row: { _id: Types.ObjectId; rosterSize: number }): [string, number] => [row._id.toString(), row.rosterSize]));
      if (teams.some((team) => (countByTeam.get(team._id.toString()) ?? 0) > maximumSquadSize)) throw new AppError(409, "SQUAD_LIMIT_EXCEEDED", "An active team already exceeds the tournament maximum squad size");
      const minimumRequiredBudget = Math.max(0, ...teams.map((team) => Math.max(0, minimumSquadSize - (countByTeam.get(team._id.toString()) ?? 0)) * input.rules.basePrice));
      if (minimumRequiredBudget > input.rules.purseBudget) throw new AppError(400, "PURSE_CANNOT_FILL_MINIMUM_SQUAD", "The purse budget cannot cover the minimum remaining squad slots at base price");
      const rulesSnapshot = {
        ...input.rules,
        minimumSquadSize,
        maximumSquadSize,
        purseUnit: "INTERNAL_CREDITS",
        tournamentRulesVersion: tournament.rulesVersion,
      };
      const [auction] = await Auction.create([{
        tenantId, tournamentId, name: input.name, slug: input.slug, status: "DRAFT", rulesSnapshot,
        sourceTournamentVersion: tournament.aggregateVersion, sourceRulesVersion: tournament.rulesVersion,
        aggregateVersion: 1, createdById: actorId,
      }], { session });
      if (!auction) throw new Error("Auction creation returned no record");
      for (const team of teams) {
        const [account] = await PurseAccount.create([{
          tenantId, tournamentId, auctionId: auction._id, teamId: team._id, budget: input.rules.purseBudget,
          reservedAmount: 0, committedAmount: 0, playersAcquired: countByTeam.get(team._id.toString()) ?? 0,
          ledgerSequence: 1, aggregateVersion: 1,
        }], { session });
        if (!account) throw new Error("Purse account creation returned no record");
        await PurseLedgerEntry.create([{
          tenantId, tournamentId, auctionId: auction._id, purseAccountId: account._id, teamId: team._id,
          sequence: 1, entryType: "BUDGET_OPENED", amount: input.rules.purseBudget,
          reservedDelta: 0, committedDelta: 0, resultingReserved: 0, resultingCommitted: 0, actorId,
        }], { session });
      }
      tournament.aggregateVersion += 1;
      await tournament.save({ session });
      await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.created", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auction.id, requestId, metadata: { tournamentId, teamCount: teams.length, sourceRulesVersion: tournament.rulesVersion, purseBudget: input.rules.purseBudget, purseUnit: "INTERNAL_CREDITS" } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "auction.created", schemaVersion: 1, aggregateType: "auction", aggregateId: auction.id, aggregateVersion: 1, visibility: "TENANT_PRIVATE", data: { auctionId: auction.id, tournamentId, status: auction.status, teamCount: teams.length, rulesVersion: tournament.rulesVersion } }, session);
      return auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "AUCTION_ALREADY_EXISTS", "An auction already exists for this tournament or slug");
    throw error;
  }
}

export async function listAuctions(tenantId: string, tournamentId: string) {
  const rows = await Auction.find({ tenantId, tournamentId }).sort({ createdAt: 1, _id: 1 }).lean();
  return rows.map((row) => auctionDto(row as unknown as Parameters<typeof auctionDto>[0]));
}

export async function getAuction(tenantId: string, auctionId: string) {
  if (!validId(auctionId)) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  const auction = await Auction.findOne({ _id: auctionId, tenantId }).lean();
  if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  return auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]);
}

export async function cancelDraftAuction(tenantId: string, auctionId: string, actorId: string, requestId: string, expectedAuctionVersion: number, reason: string) {
  if (!validId(auctionId)) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  return withTransaction(async (session: ClientSession) => {
    const auction = await Auction.findOne({ _id: auctionId, tenantId, status: "DRAFT" }).session(session);
    if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Draft auction was not found");
    if (auction.aggregateVersion !== expectedAuctionVersion) throw new AppError(409, "STALE_AUCTION_VERSION", "Auction changed; reload before retrying", { currentVersion: auction.aggregateVersion });
    if (auction.poolSize !== 0) throw new AppError(409, "AUCTION_CANNOT_BE_CANCELLED", "An auction with an approved player pool cannot be cancelled in the setup phase");
    auction.status = "CANCELLED";
    auction.aggregateVersion += 1;
    await auction.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.cancelled", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auction.id, requestId, reason, metadata: { tournamentId: auction.tournamentId.toString() } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "auction.cancelled", schemaVersion: 1, aggregateType: "auction", aggregateId: auction.id, aggregateVersion: auction.aggregateVersion, visibility: "TENANT_PRIVATE", data: { auctionId: auction.id, tournamentId: auction.tournamentId.toString(), status: auction.status } }, session);
    return auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]);
  });
}

export async function assignAuctionBidder(tenantId: string, auctionId: string, teamId: string, actorId: string, requestId: string, input: AssignAuctionBidderInput) {
  if (!validId(auctionId) || !validId(teamId) || !validId(input.userId)) throw new AppError(404, "AUCTION_TEAM_OR_USER_NOT_FOUND", "Auction, team or user was not found");
  try {
    return await withTransaction(async (session: ClientSession) => {
      const auction = await Auction.findOne({ _id: auctionId, tenantId, status: { $in: ["DRAFT", "POOL_APPROVED"] } }).session(session);
      if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found or bidder changes are locked");
      const team = await Team.findOne({ _id: teamId, tenantId, tournamentId: auction.tournamentId, status: "ACTIVE" }).session(session);
      if (!team) throw new AppError(404, "TEAM_NOT_FOUND", "Auction team was not found");
      const targetMembership = await Membership.findOne({ tenantId, userId: input.userId, status: "ACTIVE" }).session(session);
      if (!targetMembership) throw new AppError(404, "TENANT_MEMBER_NOT_FOUND", "Bidder must be an active organization member");
      const bidderStaff = await TeamStaff.findOne({ tenantId, tournamentId: auction.tournamentId, teamId, userId: input.userId, status: "ACTIVE", roles: "BIDDER" }).session(session);
      if (!bidderStaff) throw new AppError(403, "TEAM_BIDDER_ASSIGNMENT_REQUIRED", "Assign this organization member as a bidder on the team first");
      const actorMembership = await Membership.findOne({ tenantId, userId: actorId, status: "ACTIVE" }).session(session);
      const isTenantAdmin = actorMembership && ["OWNER", "ADMIN"].includes(actorMembership.role);
      const isTeamOwner = await TeamStaff.exists({ tenantId, tournamentId: auction.tournamentId, teamId, userId: actorId, status: "ACTIVE", roles: "OWNER" }).session(session);
      if (!isTenantAdmin && !isTeamOwner) throw new AppError(403, "PERMISSION_DENIED", "Team owner or organization administrator permission is required");
      let assignment = await AuctionBidder.findOne({ tenantId, auctionId, teamId, userId: input.userId }).session(session);
      if (assignment?.status === "ACTIVE") return { id: assignment.id, auctionId, teamId, userId: input.userId, status: assignment.status, assignedAt: assignment.assignedAt };
      if (assignment) {
        assignment.status = "ACTIVE";
        assignment.assignedById = new Types.ObjectId(actorId);
        assignment.assignedAt = new Date();
        await assignment.save({ session });
      } else {
        [assignment] = await AuctionBidder.create([{
          tenantId, tournamentId: auction.tournamentId, auctionId, teamId, userId: input.userId,
          status: "ACTIVE", assignedById: actorId,
        }], { session });
      }
      if (!assignment) throw new Error("Auction bidder assignment returned no record");
      auction.aggregateVersion += 1;
      await auction.save({ session });
      await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.bidder.assigned", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auctionId, requestId, metadata: { teamId, userId: input.userId } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "auction.bidder.assigned", schemaVersion: 1, aggregateType: "auction", aggregateId: auctionId, aggregateVersion: auction.aggregateVersion, visibility: "TENANT_PRIVATE", data: { auctionId, teamId, userId: input.userId, status: assignment.status } }, session);
      return { id: assignment.id, auctionId, teamId, userId: input.userId, status: assignment.status, assignedAt: assignment.assignedAt };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "BIDDER_ALREADY_ASSIGNED", "This user already has an auction bidder assignment for this team");
    throw error;
  }
}

export async function listAuctionBidders(tenantId: string, auctionId: string, teamId: string, actorId: string) {
  if (!validId(auctionId) || !validId(teamId)) throw new AppError(404, "AUCTION_OR_TEAM_NOT_FOUND", "Auction or team was not found");
  const auction = await Auction.findOne({ _id: auctionId, tenantId }).lean();
  if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  const team = await Team.findOne({ _id: teamId, tenantId, tournamentId: auction.tournamentId }).lean();
  if (!team) throw new AppError(404, "TEAM_NOT_FOUND", "Team was not found");
  const membership = await Membership.findOne({ tenantId, userId: actorId, status: "ACTIVE" });
  const isTenantAdmin = membership && ["OWNER", "ADMIN"].includes(membership.role);
  const isTeamOwner = await TeamStaff.exists({ tenantId, tournamentId: auction.tournamentId, teamId, userId: actorId, status: "ACTIVE", roles: "OWNER" });
  if (!isTenantAdmin && !isTeamOwner) throw new AppError(403, "PERMISSION_DENIED", "Team owner or organization administrator permission is required");
  const rows = await AuctionBidder.find({ tenantId, auctionId, teamId, status: "ACTIVE" }).populate({ path: "userId", select: "displayName email" }).sort({ assignedAt: 1 }).lean();
  return rows.map((row) => {
    const user = row.userId as unknown as { _id: Types.ObjectId; displayName: string; email: string } | null;
    return user ? { assignmentId: row._id.toString(), user: { id: user._id.toString(), displayName: user.displayName, email: user.email }, assignedAt: row.assignedAt } : null;
  }).filter((row) => row !== null);
}

export async function removeAuctionBidder(tenantId: string, auctionId: string, teamId: string, userId: string, actorId: string, requestId: string, reason: string) {
  if (!validId(auctionId) || !validId(teamId) || !validId(userId)) throw new AppError(404, "AUCTION_BIDDER_NOT_FOUND", "Auction bidder assignment was not found");
  return withTransaction(async (session: ClientSession) => {
    const auction = await Auction.findOne({ _id: auctionId, tenantId, status: { $in: ["DRAFT", "POOL_APPROVED"] } }).session(session);
    if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found or bidder changes are locked");
    const team = await Team.findOne({ _id: teamId, tenantId, tournamentId: auction.tournamentId }).session(session);
    if (!team) throw new AppError(404, "TEAM_NOT_FOUND", "Team was not found");
    const actorMembership = await Membership.findOne({ tenantId, userId: actorId, status: "ACTIVE" }).session(session);
    const isTenantAdmin = actorMembership && ["OWNER", "ADMIN"].includes(actorMembership.role);
    const isTeamOwner = await TeamStaff.exists({ tenantId, tournamentId: auction.tournamentId, teamId, userId: actorId, status: "ACTIVE", roles: "OWNER" }).session(session);
    if (!isTenantAdmin && !isTeamOwner) throw new AppError(403, "PERMISSION_DENIED", "Team owner or organization administrator permission is required");
    const assignment = await AuctionBidder.findOne({ tenantId, auctionId, teamId, userId, status: "ACTIVE" }).session(session);
    if (!assignment) throw new AppError(404, "AUCTION_BIDDER_NOT_FOUND", "Active bidder assignment was not found");
    if (auction.status === "POOL_APPROVED") {
      const activeCount = await AuctionBidder.countDocuments({ tenantId, auctionId, teamId, status: "ACTIVE" }).session(session);
      if (activeCount <= 1) throw new AppError(409, "AUCTION_BIDDER_REQUIRED", "Each team must keep at least one active bidder after the pool is approved");
    }
    assignment.status = "REMOVED";
    await assignment.save({ session });
    auction.aggregateVersion += 1;
    await auction.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.bidder.removed", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auctionId, requestId, reason, metadata: { teamId, userId } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "auction.bidder.removed", schemaVersion: 1, aggregateType: "auction", aggregateId: auctionId, aggregateVersion: auction.aggregateVersion, visibility: "TENANT_PRIVATE", data: { auctionId, teamId, userId, status: assignment.status } }, session);
    return { id: assignment.id, auctionId, teamId, userId, status: assignment.status };
  });
}

export async function approveAuctionPool(tenantId: string, auctionId: string, actorId: string, requestId: string, input: GenerateAuctionPoolInput) {
  if (!validId(auctionId)) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  return withTransaction(async (session: ClientSession) => {
    const auction = await Auction.findOne({ _id: auctionId, tenantId }).session(session);
    if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
    if (auction.status !== "DRAFT") throw new AppError(409, "AUCTION_POOL_LOCKED", "The player pool can only be generated once while the auction is in draft");
    if (auction.aggregateVersion !== input.expectedAuctionVersion) throw new AppError(409, "STALE_AUCTION_VERSION", "Auction changed; reload before retrying", { currentVersion: auction.aggregateVersion });
    const tournament = await Tournament.findOne({ _id: auction.tournamentId, tenantId }).session(session);
    if (!tournament || !["REGISTRATION_CLOSED", "SCHEDULED"].includes(tournament.status) || tournament.rulesVersion !== auction.sourceRulesVersion) throw new AppError(409, "AUCTION_TOURNAMENT_CHANGED", "Tournament setup changed after the auction was created");
    const accounts = await PurseAccount.find({ tenantId, auctionId }).select("teamId").session(session).lean();
    const bidderCounts = await AuctionBidder.aggregate([{ $match: { tenantId: new Types.ObjectId(tenantId), auctionId: new Types.ObjectId(auctionId), status: "ACTIVE" } }, { $group: { _id: "$teamId", count: { $sum: 1 } } }]).session(session);
    const teamsWithBidders = new Set<string>(bidderCounts.map((row: { _id: Types.ObjectId; count: number }) => row._id.toString()));
    const missingBidderTeams = accounts.filter((account) => !teamsWithBidders.has(account.teamId.toString()));
    if (missingBidderTeams.length) throw new AppError(409, "AUCTION_BIDDERS_INCOMPLETE", "Assign at least one active bidder to every auction team before approving the player pool", { teamIds: missingBidderTeams.map((account) => account.teamId.toString()) });
    const eligibleRows = await PlayerRegistration.find({ tenantId, tournamentId: auction.tournamentId, status: "APPROVED" }).select("_id playerProfileId profileSnapshot appliedAt").sort({ appliedAt: 1, _id: 1 }).session(session).lean();
    if (eligibleRows.length === 0) throw new AppError(409, "EMPTY_AUCTION_POOL", "At least one approved tournament registration is required");
    const profileIds = eligibleRows.map((row) => row.playerProfileId);
    const rostered = await RosterEntry.find({ tenantId, tournamentId: auction.tournamentId, playerProfileId: { $in: profileIds }, status: "ACTIVE" }).select("playerProfileId").session(session).lean();
    const rosteredIds = new Set(rostered.map((row) => row.playerProfileId.toString()));
    const available = eligibleRows.filter((row) => !rosteredIds.has(row.playerProfileId.toString())) as unknown as RegistrationRow[];
    if (available.length === 0) throw new AppError(409, "EMPTY_AUCTION_POOL", "All approved players already have an active direct roster assignment");
    const ordered = deterministicShuffle(available, input.seed);
    const rules = auction.rulesSnapshot as { basePrice: number };
    const lots = await AuctionLot.create(ordered.map((registration, index) => {
      const snapshot = registration.profileSnapshot;
      const profileVersion = Number(snapshot.profileVersion);
      return {
        tenantId, tournamentId: auction.tournamentId, auctionId, lotNumber: index + 1,
        registrationId: registration._id, playerProfileId: registration.playerProfileId,
        player: {
          displayName: snapshot.displayName, playingRole: snapshot.playingRole, battingHand: snapshot.battingHand,
          bowlingStyle: snapshot.bowlingStyle, wicketkeeper: snapshot.wicketkeeper,
          preferredFormats: snapshot.preferredFormats ?? [], profileVersion: Number.isInteger(profileVersion) && profileVersion > 0 ? profileVersion : 1,
        },
        openingPrice: rules.basePrice, currentPrice: rules.basePrice, status: "QUEUED", antiSnipingExtensions: 0, aggregateVersion: 1,
      };
    }), { session });
    const generatedAt = new Date();
    auction.status = "POOL_APPROVED";
    auction.poolSeed = input.seed;
    auction.poolAlgorithm = poolAlgorithm;
    auction.poolGeneratedAt = generatedAt;
    auction.poolGeneratedById = new Types.ObjectId(actorId);
    auction.poolSize = lots.length;
    auction.aggregateVersion += 1;
    await auction.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.pool.approved", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auction.id, requestId, metadata: { poolSize: lots.length, seed: input.seed, algorithm: poolAlgorithm } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "auction.pool.approved", schemaVersion: 1, aggregateType: "auction", aggregateId: auction.id, aggregateVersion: auction.aggregateVersion, visibility: "TENANT_PRIVATE", data: { auctionId: auction.id, poolSize: lots.length, seed: input.seed, algorithm: poolAlgorithm } }, session);
    return { auction: auctionDto(auction as unknown as Parameters<typeof auctionDto>[0]), lots: lots.map((lot) => lotDto(lot as unknown as Parameters<typeof lotDto>[0])) };
  });
}

export async function listAuctionLots(tenantId: string, auctionId: string) {
  if (!validId(auctionId)) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  const rows = await AuctionLot.find({ tenantId, auctionId }).sort({ lotNumber: 1 }).lean();
  return rows.map((row) => lotDto(row as unknown as Parameters<typeof lotDto>[0]));
}

export async function listAuctionPurses(tenantId: string, auctionId: string) {
  if (!validId(auctionId)) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  const auction = await Auction.findOne({ _id: auctionId, tenantId }).lean();
  if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  const rules = auction.rulesSnapshot as unknown as { purseUnitLabel: string; maximumSquadSize: number };
  const rows = await PurseAccount.find({ tenantId, auctionId }).sort({ teamId: 1 }).lean();
  return rows.map((row) => purseDto(row as unknown as Parameters<typeof purseDto>[0], rules));
}

export async function getTeamAuctionPurse(tenantId: string, auctionId: string, teamId: string, userId: string) {
  if (!validId(auctionId) || !validId(teamId)) throw new AppError(404, "PURSE_NOT_FOUND", "Purse account was not found");
  const auction = await Auction.findOne({ _id: auctionId, tenantId }).lean();
  if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  const membership = await Membership.findOne({ tenantId, userId, status: "ACTIVE" });
  const isAdmin = membership && ["OWNER", "ADMIN"].includes(membership.role);
  const teamOwner = await TeamStaff.exists({ tenantId, tournamentId: auction.tournamentId, teamId, userId, status: "ACTIVE", roles: "OWNER" });
  const bidder = await AuctionBidder.exists({ tenantId, auctionId, teamId, userId, status: "ACTIVE" });
  const bidderStaff = await TeamStaff.exists({ tenantId, tournamentId: auction.tournamentId, teamId, userId, status: "ACTIVE", roles: "BIDDER" });
  if (!isAdmin && !teamOwner && (!bidder || !bidderStaff)) throw new AppError(403, "PERMISSION_DENIED", "A team owner or assigned team bidder can view this team's purse");
  const account = await PurseAccount.findOne({ tenantId, auctionId, teamId }).lean();
  if (!account) throw new AppError(404, "PURSE_NOT_FOUND", "Purse account was not found");
  const rules = auction.rulesSnapshot as unknown as { purseUnitLabel: string; maximumSquadSize: number };
  return purseDto(account as unknown as Parameters<typeof purseDto>[0], rules);
}
