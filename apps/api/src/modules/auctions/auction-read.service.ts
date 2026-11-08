import { Types, type ClientSession } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { PlayerProfile } from "../players/models/player-profile.model.js";
import { Team } from "../teams/models/team.model.js";
import { Tournament } from "../tournaments/models/tournament.model.js";
import { Auction } from "./models/auction.model.js";
import { AuctionBid } from "./models/auction-bid.model.js";
import { AuctionLot } from "./models/auction-lot.model.js";
import { AuctionResult } from "./models/auction-result.model.js";

const validId = (id: string) => Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);
const publicAuctionStates = ["SCHEDULED", "LIVE", "PAUSED", "COMPLETED", "ARCHIVED"];
const catalogueScanSize = 400;

type ProfileRow = {
  _id: Types.ObjectId;
  displayName: string;
  playingRole: string;
  battingHand: string;
  bowlingStyle: string;
  wicketkeeper: boolean;
  preferredFormats: string[];
  aggregateVersion: number;
};
type TeamRow = { _id: Types.ObjectId; name: string; shortName: string };
type ResultLotRow = { _id: Types.ObjectId; lotNumber: number; playerProfileId: Types.ObjectId };

function publicProfileDto(profile: ProfileRow | undefined) {
  if (!profile) return null;
  return {
    displayName: profile.displayName,
    playingRole: profile.playingRole,
    battingHand: profile.battingHand,
    bowlingStyle: profile.bowlingStyle,
    wicketkeeper: profile.wicketkeeper,
    preferredFormats: profile.preferredFormats,
    profileVersion: profile.aggregateVersion,
  };
}

function publicTeamDto(team: TeamRow | undefined) {
  return team ? { id: team._id.toString(), name: team.name, shortName: team.shortName } : null;
}

function publicAuctionDto(auction: {
  _id: Types.ObjectId; tournamentId: Types.ObjectId; name: string; status: string; rulesSnapshot: Record<string, unknown>;
  poolSize: number; scheduledAt: Date | null; startedAt: Date | null; pausedAt: Date | null; currentLotId: Types.ObjectId | null; aggregateVersion: number;
}) {
  const rules = Object.fromEntries(
    ["basePrice", "minimumIncrement", "lotDurationSeconds", "antiSnipingExtensionSeconds", "antiSnipingMaxExtensions", "unsoldPolicy"]
      .filter((key) => key in auction.rulesSnapshot)
      .map((key) => [key, auction.rulesSnapshot[key]] as const),
  );
  return {
    id: auction._id.toString(), tournamentId: auction.tournamentId.toString(), name: auction.name, status: auction.status,
    rules, purseUnit: "INTERNAL_CREDITS", poolSize: auction.poolSize, scheduledAt: auction.scheduledAt, startedAt: auction.startedAt,
    pausedAt: auction.pausedAt, currentLotId: auction.currentLotId?.toString() ?? null, version: auction.aggregateVersion,
  };
}

function publicLotDto(lot: {
  _id: Types.ObjectId; lotNumber: number; attemptNumber: number; status: string; openingPrice: number; currentPrice: number;
  leadingTeamId: Types.ObjectId | null; playerProfileId: Types.ObjectId; openedAt: Date | null; closesAt: Date | null;
  bidSequence: number; antiSnipingExtensions: number; aggregateVersion: number;
}, profiles: Map<string, ProfileRow>, teams: Map<string, TeamRow>) {
  return {
    id: lot._id.toString(), lotNumber: lot.lotNumber, attemptNumber: lot.attemptNumber, status: lot.status,
    openingPrice: lot.openingPrice, currentPrice: lot.currentPrice,
    leadingTeam: lot.leadingTeamId ? publicTeamDto(teams.get(lot.leadingTeamId.toString())) : null,
    player: publicProfileDto(profiles.get(lot.playerProfileId.toString())),
    openedAt: lot.openedAt, closesAt: lot.closesAt, bidSequence: lot.bidSequence,
    antiSnipingExtensions: lot.antiSnipingExtensions, version: lot.aggregateVersion,
  };
}

function publicResultDto(
  result: { _id: Types.ObjectId; lotId: Types.ObjectId; attemptNumber: number; outcome: string; winnerTeamId: Types.ObjectId | null; finalPrice: number; finalizedAt: Date },
  lots: Map<string, ResultLotRow>,
  profiles: Map<string, ProfileRow>,
  teams: Map<string, TeamRow>,
) {
  const lot = lots.get(result.lotId.toString());
  return {
    id: result._id.toString(), lotNumber: lot?.lotNumber ?? null, attemptNumber: result.attemptNumber,
    outcome: result.outcome, winnerTeam: result.winnerTeamId ? publicTeamDto(teams.get(result.winnerTeamId.toString())) : null,
    finalPrice: result.finalPrice, finalizedAt: result.finalizedAt,
    player: lot ? publicProfileDto(profiles.get(lot.playerProfileId.toString())) : null,
  };
}

async function findPublicAuction(tournamentId: string, session: ClientSession) {
  if (!validId(tournamentId)) throw new AppError(404, "PUBLIC_AUCTION_NOT_FOUND", "Public auction was not found");
  const tournament = await Tournament.findOne({ _id: tournamentId, visibility: "PUBLIC" }).select("_id tenantId").session(session);
  if (!tournament) throw new AppError(404, "PUBLIC_AUCTION_NOT_FOUND", "Public auction was not found");
  const auction = await Auction.findOne({ tenantId: tournament.tenantId, tournamentId: tournament._id, status: { $in: publicAuctionStates } })
    .sort({ createdAt: -1 })
    .session(session);
  if (!auction) throw new AppError(404, "PUBLIC_AUCTION_NOT_FOUND", "Public auction was not found");
  return { tournament, auction };
}

async function loadPublicProfiles(profileIds: Types.ObjectId[], session: ClientSession) {
  if (profileIds.length === 0) return new Map<string, ProfileRow>();
  const profiles = await PlayerProfile.find({ _id: { $in: profileIds }, status: "ACTIVE", visibility: "PUBLIC" })
    .select("displayName playingRole battingHand bowlingStyle wicketkeeper preferredFormats aggregateVersion")
    .session(session)
    .lean();
  return new Map(profiles.map((profile) => [profile._id.toString(), profile as unknown as ProfileRow] as const));
}

async function loadTeams(teamIds: Types.ObjectId[], tournamentId: Types.ObjectId, tenantId: Types.ObjectId, session: ClientSession) {
  if (teamIds.length === 0) return new Map<string, TeamRow>();
  const teams = await Team.find({ _id: { $in: teamIds }, tournamentId, tenantId })
    .select("name shortName")
    .session(session)
    .lean();
  return new Map(teams.map((team) => [team._id.toString(), { ...team, shortName: team.shortName ?? "" } as unknown as TeamRow] as const));
}

export async function getPublicAuctionSnapshot(tournamentId: string, limit: number, afterLotNumber = 0) {
  return withTransaction(async (session) => {
    const { tournament, auction } = await findPublicAuction(tournamentId, session);
    const currentLot = auction.currentLotId
      ? await AuctionLot.findOne({ _id: auction.currentLotId, tenantId: tournament.tenantId, auctionId: auction._id, status: { $in: ["OPEN", "PAUSED"] } }).session(session).lean()
      : null;
    if (auction.currentLotId && !currentLot) throw new AppError(409, "PUBLIC_AUCTION_SNAPSHOT_INCONSISTENT", "Auction current lot is unavailable; retry after state recovery");
    const queuedLots = await AuctionLot.find({ tenantId: tournament.tenantId, auctionId: auction._id, status: "QUEUED", lotNumber: { $gt: afterLotNumber } })
      .sort({ lotNumber: 1 })
      .limit(catalogueScanSize)
      .session(session)
      .lean();
    const bids = currentLot
      ? await AuctionBid.find({ tenantId: tournament.tenantId, lotId: currentLot._id }).select("sequence teamId amount acceptedAt lotVersionAfter").sort({ sequence: -1 }).limit(25).session(session).lean()
      : [];
    const recentResults = await AuctionResult.find({ tenantId: tournament.tenantId, auctionId: auction._id }).sort({ _id: -1 }).limit(10).session(session).lean();
    const resultLotIds = recentResults.map((result) => result.lotId);
    const resultLots = resultLotIds.length
      ? await AuctionLot.find({ _id: { $in: resultLotIds }, tenantId: tournament.tenantId, auctionId: auction._id }).select("lotNumber playerProfileId").session(session).lean()
      : [];
    const resultLotsById = new Map(resultLots.map((lot) => [lot._id.toString(), lot as unknown as ResultLotRow] as const));
    const profileIds = [
      ...(currentLot ? [currentLot.playerProfileId] : []),
      ...queuedLots.map((lot) => lot.playerProfileId),
      ...resultLots.map((lot) => lot.playerProfileId),
    ];
    const profiles = await loadPublicProfiles(profileIds, session);
    const teamIds = [
      ...(currentLot?.leadingTeamId ? [currentLot.leadingTeamId] : []),
      ...recentResults.flatMap((result) => result.winnerTeamId ? [result.winnerTeamId] : []),
      ...bids.map((bid) => bid.teamId),
    ];
    const teams = await loadTeams(teamIds, tournament._id, tournament.tenantId, session);
    const visibleQueuedLots = queuedLots
      .filter((lot) => profiles.has(lot.playerProfileId.toString()))
      .slice(0, limit);
    const nextLotCursor = visibleQueuedLots.length === limit
      ? visibleQueuedLots.at(-1)!.lotNumber
      : queuedLots.length === catalogueScanSize
        ? queuedLots.at(-1)!.lotNumber
        : null;
    return {
      auction: publicAuctionDto(auction as unknown as Parameters<typeof publicAuctionDto>[0]),
      currentLot: currentLot ? publicLotDto(currentLot as unknown as Parameters<typeof publicLotDto>[0], profiles, teams) : null,
      recentBids: bids.reverse().map((bid) => ({ sequence: bid.sequence, team: publicTeamDto(teams.get(bid.teamId.toString())), amount: bid.amount, acceptedAt: bid.acceptedAt, lotVersion: bid.lotVersionAfter })),
      queuedLots: visibleQueuedLots.map((lot) => publicLotDto(lot as unknown as Parameters<typeof publicLotDto>[0], profiles, teams)),
      nextLotCursor,
      recentResults: recentResults.map((result) => publicResultDto(result as unknown as Parameters<typeof publicResultDto>[0], resultLotsById, profiles, teams)),
      snapshotAt: new Date(),
    };
  });
}

export async function listPublicAuctionResults(tournamentId: string, limit: number, beforeId?: string) {
  return withTransaction(async (session) => {
    const { tournament, auction } = await findPublicAuction(tournamentId, session);
    const results = await AuctionResult.find({
      tenantId: tournament.tenantId,
      auctionId: auction._id,
      ...(beforeId ? { _id: { $lt: new Types.ObjectId(beforeId) } } : {}),
    }).sort({ _id: -1 }).limit(limit + 1).session(session).lean();
    const hasMore = results.length > limit;
    const page = results.slice(0, limit);
    const pageLotIds = page.map((result) => result.lotId);
    const lots = pageLotIds.length
      ? await AuctionLot.find({ _id: { $in: pageLotIds }, tenantId: tournament.tenantId, auctionId: auction._id }).select("lotNumber playerProfileId").session(session).lean()
      : [];
    const profiles = await loadPublicProfiles(lots.map((lot) => lot.playerProfileId), session);
    const teams = await loadTeams(page.flatMap((result) => result.winnerTeamId ? [result.winnerTeamId] : []), tournament._id, tournament.tenantId, session);
    const lotsById = new Map(lots.map((lot) => [lot._id.toString(), lot as unknown as ResultLotRow] as const));
    return {
      results: page.map((result) => publicResultDto(result as unknown as Parameters<typeof publicResultDto>[0], lotsById, profiles, teams)),
      nextCursor: hasMore ? page.at(-1)?._id.toString() ?? null : null,
    };
  });
}

export async function listAuctionBidHistory(tenantId: string, auctionId: string, lotId: string, limit: number, beforeSequence?: number) {
  if (!validId(auctionId) || !validId(lotId)) throw new AppError(404, "AUCTION_LOT_NOT_FOUND", "Auction lot was not found");
  const auction = await Auction.findOne({ _id: auctionId, tenantId }).select("_id").lean();
  if (!auction) throw new AppError(404, "AUCTION_NOT_FOUND", "Auction was not found");
  const lot = await AuctionLot.findOne({ _id: lotId, tenantId, auctionId }).select("_id").lean();
  if (!lot) throw new AppError(404, "AUCTION_LOT_NOT_FOUND", "Auction lot was not found");
  const bids = await AuctionBid.find({ tenantId, auctionId, lotId, ...(beforeSequence ? { sequence: { $lt: beforeSequence } } : {}) })
    .select("sequence teamId amount acceptedAt lotVersionAfter")
    .sort({ sequence: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = bids.length > limit;
  const page = bids.slice(0, limit);
  return {
    bids: page.map((bid) => ({ id: bid._id.toString(), sequence: bid.sequence, teamId: bid.teamId.toString(), amount: bid.amount, acceptedAt: bid.acceptedAt, lotVersion: bid.lotVersionAfter })),
    nextCursor: hasMore ? page.at(-1)?.sequence ?? null : null,
  };
}
