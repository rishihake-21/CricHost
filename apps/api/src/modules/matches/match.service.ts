import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { Fixture } from "../fixtures/models/fixture.model.js";
import { Tournament } from "../tournaments/models/tournament.model.js";
import { Membership } from "../memberships/models/membership.model.js";
import { Match } from "./models/match.model.js";
import { MatchScorer } from "./models/match-scorer.model.js";
import { Innings } from "../scoring/models/innings.model.js";
import { RosterEntry } from "../rosters/models/roster-entry.model.js";
import { TournamentStanding } from "../fixtures/models/standing.model.js";

const validId = (id: string) => Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);
export const isStandardLimitedOversFormat = (format: string) => ["T10", "T20", "ODI"].includes(format);
function snapshotMatch(match: {
  _id: Types.ObjectId; tenantId: Types.ObjectId; tournamentId: Types.ObjectId; fixtureId: Types.ObjectId;
  fixtureNumber: number; roundNumber: number;
  home: { teamId: Types.ObjectId; name: string; slug: string; seed: number };
  away: { teamId: Types.ObjectId; name: string; slug: string; seed: number };
  scheduledAt: Date; rules: Record<string, unknown>; status: string; tossWinnerTeamId: Types.ObjectId | null;
  tossDecision: string | null; firstBattingTeamId: Types.ObjectId | null; currentInningsNumber: number;
  startedAt: Date | null; completedAt: Date | null; aggregateVersion: number;
  result: { outcome: string; winnerTeamId: Types.ObjectId | null; marginType: string | null; marginValue: number | null; decisionMethod: string; decidedAt: Date } | null;
}) {
  return {
    id: match._id.toString(), tenantId: match.tenantId.toString(), tournamentId: match.tournamentId.toString(), fixtureId: match.fixtureId.toString(),
    fixtureNumber: match.fixtureNumber, roundNumber: match.roundNumber,
    home: { teamId: match.home.teamId.toString(), name: match.home.name, slug: match.home.slug, seed: match.home.seed },
    away: { teamId: match.away.teamId.toString(), name: match.away.name, slug: match.away.slug, seed: match.away.seed },
    scheduledAt: match.scheduledAt, rules: match.rules, status: match.status,
    tossWinnerTeamId: match.tossWinnerTeamId?.toString() ?? null, tossDecision: match.tossDecision,
    firstBattingTeamId: match.firstBattingTeamId?.toString() ?? null, currentInningsNumber: match.currentInningsNumber,
    startedAt: match.startedAt, completedAt: match.completedAt, version: match.aggregateVersion,
    result: match.result ? { outcome: match.result.outcome, winnerTeamId: match.result.winnerTeamId?.toString() ?? null, marginType: match.result.marginType, marginValue: match.result.marginValue, decisionMethod: match.result.decisionMethod, decidedAt: match.result.decidedAt } : null,
  };
}

export function toInningsSnapshot(innings: {
  _id: Types.ObjectId; number: number; battingTeamId: Types.ObjectId; bowlingTeamId: Types.ObjectId; status: string;
  closureType: string | null;
  runs: number; wickets: number; legalBalls: number; extras: { wides: number; noBalls: number; byes: number; legByes: number };
  eventHead: number; scorerUserId: Types.ObjectId | null; leaseEpoch: number; leaseExpiresAt: Date | null; aggregateVersion: number;
}) {
  return {
    id: innings._id.toString(), number: innings.number, battingTeamId: innings.battingTeamId.toString(), bowlingTeamId: innings.bowlingTeamId.toString(),
    status: innings.status, closureType: innings.closureType,
    score: { runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls, extras: innings.extras },
    eventHead: innings.eventHead, scorerLease: { held: Boolean(innings.scorerUserId && innings.leaseExpiresAt && innings.leaseExpiresAt > new Date()), epoch: innings.leaseEpoch, expiresAt: innings.leaseExpiresAt },
    version: innings.aggregateVersion,
  };
}

export async function enqueuePublicMatchSnapshotNotice(session: ClientSession, tenantId: string, tournamentId: string, matchId: string, aggregateVersion: number) {
  const tournament = await Tournament.findOne({ _id: tournamentId, tenantId }).select("visibility").session(session);
  if (!tournament || tournament.visibility !== "PUBLIC") return;
  await enqueueOutboxEvent({
    tenantId,
    eventType: "match.snapshot.changed",
    schemaVersion: 1,
    aggregateType: "match",
    aggregateId: matchId,
    aggregateVersion,
    visibility: "PUBLIC",
    data: { matchId, tournamentId },
  }, session);
}

export async function createMatch(tenantId: string, tournamentId: string, fixtureId: string, actorId: string, requestId: string, expectedFixtureVersion: number) {
  if (!validId(tournamentId) || !validId(fixtureId)) throw new AppError(404, "FIXTURE_NOT_FOUND", "Fixture was not found");
  try {
    return await withTransaction(async (session: ClientSession) => {
      const fixture = await Fixture.findOne({ _id: fixtureId, tenantId, tournamentId }).session(session);
      if (!fixture) throw new AppError(404, "FIXTURE_NOT_FOUND", "Fixture was not found");
      if (fixture.aggregateVersion !== expectedFixtureVersion) throw new AppError(409, "STALE_FIXTURE_VERSION", "Fixture changed; reload before retrying", { currentVersion: fixture.aggregateVersion });
      if (fixture.status !== "SCHEDULED") throw new AppError(409, "MATCH_CREATION_LOCKED", "A match can only be created for a scheduled fixture");
      const prior = await Match.findOne({ tenantId, fixtureId }).session(session);
      if (prior) throw new AppError(409, "MATCH_ALREADY_EXISTS", "A match already exists for this fixture");
      const tournament = await Tournament.findOne({ _id: tournamentId, tenantId }).session(session);
      if (!tournament) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
      if (!["SCHEDULED", "LIVE"].includes(tournament.status)) throw new AppError(409, "MATCH_CREATION_LOCKED", "Matches require a scheduled or live tournament");
      const sourceRules = tournament.rules as Record<string, unknown>;
      const rules = {
        format: tournament.format,
        inningsPerMatch: Number(sourceRules.inningsPerMatch),
        oversPerInnings: sourceRules.oversPerInnings === null || sourceRules.oversPerInnings === undefined ? null : Number(sourceRules.oversPerInnings),
        ballsPerOver: Number(sourceRules.ballsPerOver ?? 6),
        playersPerSide: Number(sourceRules.playersPerSide ?? 11),
        followOnEnabled: Boolean(sourceRules.followOnEnabled ?? false),
        tiePolicy: String(sourceRules.tiePolicy ?? "DRAW"),
        pointsForWin: Number(sourceRules.pointsForWin ?? 2),
        pointsForTie: Number(sourceRules.pointsForTie ?? 1),
        pointsForNoResult: Number(sourceRules.pointsForNoResult ?? 1),
        rulesVersion: tournament.rulesVersion,
      };
      const validOvers = rules.oversPerInnings === null || (Number.isInteger(rules.oversPerInnings) && rules.oversPerInnings >= 1 && rules.oversPerInnings <= 100);
      if (!Number.isInteger(rules.inningsPerMatch) || rules.inningsPerMatch < 1 || rules.inningsPerMatch > 4 || !Number.isInteger(rules.ballsPerOver) || rules.ballsPerOver < 4 || rules.ballsPerOver > 8 || !Number.isInteger(rules.playersPerSide) || rules.playersPerSide < 2 || rules.playersPerSide > 15 || !validOvers || !["SUPER_OVER", "DRAW", "REPLAY", "POINTS"].includes(rules.tiePolicy)) {
        throw new AppError(409, "MATCH_RULES_INVALID", "Tournament rules cannot be frozen into a match; review the configured innings and ball limits");
      }
      const [match] = await Match.create([{
        tenantId, tournamentId, fixtureId, fixtureNumber: fixture.fixtureNumber, roundNumber: fixture.roundNumber,
        home: fixture.home, away: fixture.away, scheduledAt: fixture.startsAt, rules, status: "SCHEDULED", createdById: actorId,
      }], { session });
      if (!match) throw new Error("Match creation returned no record");
      await recordAudit({ actorType: "USER", actorId, tenantId, action: "match.created", outcome: "SUCCEEDED", resourceType: "match", resourceId: match.id, requestId, metadata: { tournamentId, fixtureId, rulesVersion: rules.rulesVersion } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "match.created", schemaVersion: 1, aggregateType: "match", aggregateId: match.id, aggregateVersion: match.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId: match.id, tournamentId, fixtureId, fixtureNumber: match.fixtureNumber, status: match.status } }, session);
      await enqueuePublicMatchSnapshotNotice(session, tenantId, tournamentId, match.id, match.aggregateVersion);
      return snapshotMatch(match as unknown as Parameters<typeof snapshotMatch>[0]);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "MATCH_ALREADY_EXISTS", "A match already exists for this fixture");
    throw error;
  }
}

export async function startMatch(tenantId: string, tournamentId: string, matchId: string, actorId: string, requestId: string, input: { expectedMatchVersion: number; tossWinnerTeamId: string; tossDecision: "BAT" | "BOWL" }) {
  if (!validId(matchId)) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  return withTransaction(async (session: ClientSession) => {
    const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).session(session);
    if (!match) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
    if (match.aggregateVersion !== input.expectedMatchVersion) throw new AppError(409, "STALE_MATCH_VERSION", "Match changed; reload before retrying", { currentVersion: match.aggregateVersion });
    if (match.status !== "SCHEDULED") throw new AppError(409, "MATCH_NOT_STARTABLE", "Only a scheduled match can start");
    if (match.scheduledAt > new Date()) throw new AppError(409, "MATCH_NOT_DUE", "A match cannot start before its scheduled time");
    const homeId = match.home.teamId.toString();
    const awayId = match.away.teamId.toString();
    if (![homeId, awayId].includes(input.tossWinnerTeamId)) throw new AppError(400, "INVALID_TOSS_TEAM", "Toss winner must be one of the match teams");
    const rosterRows = await RosterEntry.find({ tenantId, tournamentId, status: "ACTIVE", teamId: { $in: [homeId, awayId] } }).select("teamId playerProfileId").session(session).lean();
    const homeRosterProfileIds = rosterRows.filter((row) => row.teamId.toString() === homeId).map((row) => row.playerProfileId);
    const awayRosterProfileIds = rosterRows.filter((row) => row.teamId.toString() === awayId).map((row) => row.playerProfileId);
    if (homeRosterProfileIds.length < match.rules.playersPerSide || awayRosterProfileIds.length < match.rules.playersPerSide) {
      throw new AppError(409, "MATCH_ROSTER_INCOMPLETE", "Each team must have enough active roster players to field the configured side");
    }
    match.homeRosterProfileIds = homeRosterProfileIds;
    match.awayRosterProfileIds = awayRosterProfileIds;
    const firstBattingTeamId = input.tossDecision === "BAT" ? input.tossWinnerTeamId : input.tossWinnerTeamId === homeId ? awayId : homeId;
    const bowlingTeamId = firstBattingTeamId === homeId ? awayId : homeId;
    const [innings] = await Innings.create([{
      tenantId, tournamentId, matchId, number: 1, battingTeamId: firstBattingTeamId, bowlingTeamId,
      status: "LIVE", runs: 0, wickets: 0, legalBalls: 0, extras: {}, eventHead: 0,
    }], { session });
    if (!innings) throw new Error("First innings creation returned no record");
    match.status = "LIVE";
    match.tossWinnerTeamId = new Types.ObjectId(input.tossWinnerTeamId);
    match.tossDecision = input.tossDecision;
    match.firstBattingTeamId = new Types.ObjectId(firstBattingTeamId);
    match.currentInningsNumber = 1;
    match.startedAt = new Date();
    match.aggregateVersion += 1;
    await match.save({ session });
    const fixture = await Fixture.findOne({ _id: match.fixtureId, tenantId, tournamentId, status: "SCHEDULED" }).session(session);
    if (!fixture) throw new AppError(409, "FIXTURE_STATE_CONFLICT", "Fixture is no longer scheduled");
    fixture.status = "IN_PROGRESS";
    fixture.aggregateVersion += 1;
    await fixture.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "match.started", outcome: "SUCCEEDED", resourceType: "match", resourceId: match.id, requestId, metadata: { tossWinnerTeamId: input.tossWinnerTeamId, tossDecision: input.tossDecision, firstBattingTeamId } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "match.started", schemaVersion: 1, aggregateType: "match", aggregateId: match.id, aggregateVersion: match.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId: match.id, tournamentId, fixtureId: match.fixtureId.toString(), firstInningsNumber: 1, status: match.status } }, session);
    await enqueuePublicMatchSnapshotNotice(session, tenantId, tournamentId, match.id, match.aggregateVersion);
    return { match: snapshotMatch(match as unknown as Parameters<typeof snapshotMatch>[0]), innings: toInningsSnapshot(innings as unknown as Parameters<typeof toInningsSnapshot>[0]) };
  });
}

export async function assignMatchScorer(tenantId: string, tournamentId: string, matchId: string, userId: string, assignedById: string, requestId: string) {
  if (!validId(matchId) || !validId(userId)) throw new AppError(404, "MATCH_OR_USER_NOT_FOUND", "Match or user was not found");
  return withTransaction(async (session: ClientSession) => {
    const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).session(session);
    if (!match || match.status === "COMPLETED" || match.status === "ABANDONED") throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
    const membership = await Membership.findOne({ tenantId, userId, status: "ACTIVE" }).session(session);
    if (!membership) throw new AppError(409, "SCORER_MUST_BE_ACTIVE_MEMBER", "Scorer must be an active member of this organization");
    let assignment = await MatchScorer.findOne({ tenantId, matchId, userId }).session(session);
    if (assignment?.status === "ACTIVE") return { matchId, userId, status: "ACTIVE", replayed: true };
    if (assignment) {
      assignment.status = "ACTIVE";
      assignment.assignedById = new Types.ObjectId(assignedById);
      assignment.assignedAt = new Date();
      assignment.removedAt = null;
      await assignment.save({ session });
    } else {
      [assignment] = await MatchScorer.create([{ tenantId, tournamentId, matchId, userId, status: "ACTIVE", assignedById }], { session });
    }
    if (!assignment) throw new Error("Scorer assignment returned no record");
    match.aggregateVersion += 1;
    await match.save({ session });
    await recordAudit({ actorType: "USER", actorId: assignedById, tenantId, action: "match.scorer.assigned", outcome: "SUCCEEDED", resourceType: "match", resourceId: matchId, requestId, metadata: { userId } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "match.scorer.assigned", schemaVersion: 1, aggregateType: "match", aggregateId: matchId, aggregateVersion: match.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId, tournamentId, userId, status: "ACTIVE" } }, session);
    return { matchId, userId, status: assignment.status, replayed: false };
  });
}

export async function removeMatchScorer(tenantId: string, tournamentId: string, matchId: string, userId: string, removedById: string, requestId: string) {
  if (!validId(matchId) || !validId(userId)) throw new AppError(404, "MATCH_OR_USER_NOT_FOUND", "Match or user was not found");
  return withTransaction(async (session: ClientSession) => {
    const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).session(session);
    if (!match) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
    const assignment = await MatchScorer.findOne({ tenantId, matchId, userId }).session(session);
    if (!assignment || assignment.status === "REMOVED") return { matchId, userId, status: "REMOVED", replayed: true };
    assignment.status = "REMOVED";
    assignment.removedAt = new Date();
    await assignment.save({ session });
    const heldLeases = await Innings.find({ tenantId, matchId, scorerUserId: userId, status: "LIVE" }).session(session);
    for (const innings of heldLeases) {
      innings.scorerUserId = null;
      innings.leaseExpiresAt = null;
      innings.leaseEpoch += 1;
      innings.aggregateVersion += 1;
      await innings.save({ session });
      await enqueueOutboxEvent({ tenantId, eventType: "match.scorer_lease.revoked", schemaVersion: 1, aggregateType: "match_innings", aggregateId: innings.id, aggregateVersion: innings.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId, tournamentId, inningsNumber: innings.number, leaseEpoch: innings.leaseEpoch } }, session);
    }
    match.aggregateVersion += 1;
    await match.save({ session });
    await recordAudit({ actorType: "USER", actorId: removedById, tenantId, action: "match.scorer.removed", outcome: "SUCCEEDED", resourceType: "match", resourceId: matchId, requestId, metadata: { userId, revokedLeaseCount: heldLeases.length } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "match.scorer.removed", schemaVersion: 1, aggregateType: "match", aggregateId: matchId, aggregateVersion: match.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId, tournamentId, userId, status: "REMOVED" } }, session);
    return { matchId, userId, status: assignment.status, revokedLeaseCount: heldLeases.length, replayed: false };
  });
}

export async function getMatchSnapshot(tenantId: string, tournamentId: string, matchId: string) {
  if (!validId(matchId)) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).lean();
  if (!match) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  const innings = await Innings.find({ tenantId, matchId }).sort({ number: 1 }).lean();
  return { match: snapshotMatch(match as unknown as Parameters<typeof snapshotMatch>[0]), innings: innings.map((row) => toInningsSnapshot(row as unknown as Parameters<typeof toInningsSnapshot>[0])) };
}

export async function listTournamentMatches(tenantId: string, tournamentId: string) {
  const matches = await Match.find({ tenantId, tournamentId }).sort({ scheduledAt: 1, fixtureNumber: 1 }).lean();
  return matches.map((match) => snapshotMatch(match as unknown as Parameters<typeof snapshotMatch>[0]));
}

export type MatchDecision = {
  outcome: "HOME_WIN" | "AWAY_WIN" | "TIE" | "NO_RESULT";
  winnerTeamId: string | null;
  marginType: "RUNS" | "WICKETS" | null;
  marginValue: number | null;
  decisionMethod: "SCORECARD" | "ADMINISTRATIVE";
};

export async function finalizeMatchAndStandings(
  session: ClientSession, tenantId: string, tournamentId: string, matchId: string,
  decision: MatchDecision, actor: { type: "USER" | "SYSTEM"; id?: string }, reason: string, requestId: string,
) {
  const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).session(session);
  if (!match || match.status !== "LIVE") throw new AppError(409, "MATCH_NOT_LIVE", "Only a live match can be completed");
  const innings = await Innings.find({ tenantId, matchId }).sort({ number: 1 }).session(session);
  if (innings.length === 0 || innings.some((row) => row.status !== "COMPLETED")) throw new AppError(409, "MATCH_INNINGS_INCOMPLETE", "Every active innings must be closed before match completion");
  if (decision.outcome !== "NO_RESULT" && match.rules.format !== "TEST" && innings.length !== match.rules.inningsPerMatch) {
    throw new AppError(409, "MATCH_INNINGS_INCOMPLETE", "The configured limited-overs innings must be complete before adjudication");
  }
  const homeId = match.home.teamId.toString();
  const awayId = match.away.teamId.toString();
  const winnerIsHome = decision.winnerTeamId === homeId;
  const winnerIsAway = decision.winnerTeamId === awayId;
  if ((decision.outcome === "HOME_WIN" && !winnerIsHome) || (decision.outcome === "AWAY_WIN" && !winnerIsAway) || ((decision.outcome === "TIE" || decision.outcome === "NO_RESULT") && decision.winnerTeamId !== null)) {
    throw new AppError(400, "MATCH_RESULT_WINNER_INVALID", "Result winner must match the selected match outcome");
  }

  const isLimitedTwoInnings = isStandardLimitedOversFormat(match.rules.format) && match.rules.inningsPerMatch === 2;
  let resultMarginType = decision.marginType;
  let resultMarginValue = decision.marginValue;
  if (isLimitedTwoInnings && decision.outcome !== "NO_RESULT") {
    if (innings.length !== 2) throw new AppError(409, "MATCH_INNINGS_INCOMPLETE", "Both limited-overs innings must be complete before result adjudication");
    const homeRuns = innings.filter((row) => row.battingTeamId.equals(match.home.teamId)).reduce((sum, row) => sum + row.runs, 0);
    const awayRuns = innings.filter((row) => row.battingTeamId.equals(match.away.teamId)).reduce((sum, row) => sum + row.runs, 0);
    const expectedOutcome = homeRuns === awayRuns ? "TIE" : homeRuns > awayRuns ? "HOME_WIN" : "AWAY_WIN";
    const needsAdministrativeTiebreak = expectedOutcome === "TIE" && ["SUPER_OVER", "REPLAY"].includes(match.rules.tiePolicy);
    if (needsAdministrativeTiebreak && decision.decisionMethod !== "ADMINISTRATIVE") {
      throw new AppError(409, "MATCH_TIEBREAKER_REQUIRED", "The configured tie-breaker requires an explicit administrative resolution");
    }
    if (!needsAdministrativeTiebreak && decision.outcome !== expectedOutcome) throw new AppError(409, "MATCH_RESULT_SCORE_MISMATCH", "The selected result does not match completed innings scores", { homeRuns, awayRuns, expectedOutcome });
    if (expectedOutcome === "TIE") {
      resultMarginType = null;
      resultMarginValue = null;
    } else {
      const chasingTeamId = innings[1]!.battingTeamId.toString();
      const winnerIsChasingTeam = decision.winnerTeamId === chasingTeamId;
      if (winnerIsChasingTeam) {
        resultMarginType = "WICKETS";
        resultMarginValue = Math.max(0, match.rules.playersPerSide - 1 - innings[1]!.wickets);
      } else {
        resultMarginType = "RUNS";
        resultMarginValue = Math.abs(homeRuns - awayRuns);
      }
    }
  } else if (decision.decisionMethod === "SCORECARD") {
    throw new AppError(409, "SCORECARD_RESULT_UNAVAILABLE", "This result requires explicit administrative adjudication");
  }

  const homeStanding = await TournamentStanding.findOne({ tenantId, tournamentId, teamId: match.home.teamId }).session(session);
  const awayStanding = await TournamentStanding.findOne({ tenantId, tournamentId, teamId: match.away.teamId }).session(session);
  if (!homeStanding || !awayStanding) throw new AppError(409, "STANDINGS_NOT_INITIALIZED", "Both match teams require a tournament standings row before completion");

  homeStanding.played += 1;
  awayStanding.played += 1;
  if (decision.outcome === "HOME_WIN") { homeStanding.won += 1; awayStanding.lost += 1; homeStanding.points += match.rules.pointsForWin; }
  else if (decision.outcome === "AWAY_WIN") { awayStanding.won += 1; homeStanding.lost += 1; awayStanding.points += match.rules.pointsForWin; }
  else if (decision.outcome === "TIE") { homeStanding.tied += 1; awayStanding.tied += 1; homeStanding.points += match.rules.pointsForTie; awayStanding.points += match.rules.pointsForTie; }
  else { homeStanding.noResult += 1; awayStanding.noResult += 1; homeStanding.points += match.rules.pointsForNoResult; awayStanding.points += match.rules.pointsForNoResult; }

  if (decision.outcome !== "NO_RESULT" && isStandardLimitedOversFormat(match.rules.format)) {
    const quotaBalls = match.rules.oversPerInnings === null ? null : match.rules.oversPerInnings * match.rules.ballsPerOver;
    const ballsFor = (rows: typeof innings) => rows.reduce((sum, row) => sum + (quotaBalls !== null && row.wickets >= match.rules.playersPerSide - 1 ? quotaBalls : row.legalBalls), 0);
    const homeInnings = innings.filter((row) => row.battingTeamId.equals(match.home.teamId));
    const awayInnings = innings.filter((row) => row.battingTeamId.equals(match.away.teamId));
    const homeRuns = homeInnings.reduce((sum, row) => sum + row.runs, 0);
    const awayRuns = awayInnings.reduce((sum, row) => sum + row.runs, 0);
    const homeBalls = ballsFor(homeInnings);
    const awayBalls = ballsFor(awayInnings);
    homeStanding.runsFor += homeRuns; homeStanding.ballsFaced += homeBalls;
    homeStanding.runsAgainst += awayRuns; homeStanding.ballsBowled += awayBalls;
    awayStanding.runsFor += awayRuns; awayStanding.ballsFaced += awayBalls;
    awayStanding.runsAgainst += homeRuns; awayStanding.ballsBowled += homeBalls;
    const rate = (runs: number, balls: number) => balls > 0 ? runs * match.rules.ballsPerOver / balls : 0;
    homeStanding.netRunRate = Number((rate(homeStanding.runsFor, homeStanding.ballsFaced) - rate(homeStanding.runsAgainst, homeStanding.ballsBowled)).toFixed(3));
    awayStanding.netRunRate = Number((rate(awayStanding.runsFor, awayStanding.ballsFaced) - rate(awayStanding.runsAgainst, awayStanding.ballsBowled)).toFixed(3));
  }
  homeStanding.aggregateVersion += 1;
  homeStanding.updatedAt = new Date();
  awayStanding.aggregateVersion += 1;
  awayStanding.updatedAt = new Date();
  await homeStanding.save({ session });
  await awayStanding.save({ session });

  const decidedAt = new Date();
  match.status = "COMPLETED";
  match.completedAt = decidedAt;
  match.result = {
    outcome: decision.outcome,
    winnerTeamId: decision.winnerTeamId ? new Types.ObjectId(decision.winnerTeamId) : null,
    marginType: resultMarginType,
    marginValue: resultMarginValue,
    decisionMethod: decision.decisionMethod,
    decidedById: actor.type === "USER" && actor.id ? new Types.ObjectId(actor.id) : null,
    decidedAt,
  };
  match.aggregateVersion += 1;
  await match.save({ session });
  const fixture = await Fixture.findOne({ _id: match.fixtureId, tenantId, tournamentId }).session(session);
  if (!fixture) throw new AppError(409, "MATCH_FIXTURE_MISSING", "The match fixture is missing; operator review is required");
  fixture.status = "COMPLETED";
  fixture.aggregateVersion += 1;
  await fixture.save({ session });
  await recordAudit({ actorType: actor.type, ...(actor.type === "USER" && actor.id ? { actorId: actor.id } : {}), tenantId, action: "match.completed", outcome: "SUCCEEDED", resourceType: "match", resourceId: match.id, requestId, reason, metadata: { outcome: decision.outcome, winnerTeamId: decision.winnerTeamId, marginType: resultMarginType, marginValue: resultMarginValue, decisionMethod: decision.decisionMethod, inningsCount: innings.length } }, session);
  await enqueueOutboxEvent({ tenantId, eventType: "match.completed", schemaVersion: 1, aggregateType: "match", aggregateId: match.id, aggregateVersion: match.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId: match.id, tournamentId, fixtureId: match.fixtureId.toString(), outcome: decision.outcome, winnerTeamId: decision.winnerTeamId, status: match.status } }, session);
  await enqueuePublicMatchSnapshotNotice(session, tenantId, tournamentId, match.id, match.aggregateVersion);
  return snapshotMatch(match as unknown as Parameters<typeof snapshotMatch>[0]);
}

export async function completeMatch(
  tenantId: string, tournamentId: string, matchId: string, actorId: string, requestId: string,
  input: { expectedMatchVersion: number; outcome: "HOME_WIN" | "AWAY_WIN" | "TIE" | "NO_RESULT"; reason: string },
) {
  if (!validId(matchId)) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  return withTransaction(async (session: ClientSession) => {
    const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).session(session);
    if (!match || match.status !== "LIVE") throw new AppError(404, "LIVE_MATCH_NOT_FOUND", "Live match was not found");
    if (match.aggregateVersion !== input.expectedMatchVersion) throw new AppError(409, "STALE_MATCH_VERSION", "Match changed; reload before retrying", { currentVersion: match.aggregateVersion });
    const innings = await Innings.find({ tenantId, matchId }).sort({ number: 1 }).session(session);
    if (innings.length === 0) throw new AppError(409, "MATCH_INNINGS_MISSING", "A live match must have at least one innings before completion");
    if (input.outcome === "NO_RESULT") {
      for (const row of innings) {
        if (row.status === "COMPLETED") continue;
        row.status = "COMPLETED";
        row.closureType = "MANUAL";
        if (row.scorerUserId) row.leaseEpoch += 1;
        row.scorerUserId = null;
        row.leaseExpiresAt = null;
        row.aggregateVersion += 1;
        await row.save({ session });
        await enqueueOutboxEvent({ tenantId, eventType: "match.innings.closed", schemaVersion: 1, aggregateType: "match_innings", aggregateId: row.id, aggregateVersion: row.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId, tournamentId, inningsNumber: row.number, status: row.status, reasonCode: "MATCH_NO_RESULT" } }, session);
      }
    } else if (innings.some((row) => row.status !== "COMPLETED")) {
      throw new AppError(409, "MATCH_INNINGS_INCOMPLETE", "Close all innings before entering a match result");
    }

    const isLimitedTwoInnings = isStandardLimitedOversFormat(match.rules.format) && match.rules.inningsPerMatch === 2;
    let winnerTeamId: string | null = input.outcome === "HOME_WIN" ? match.home.teamId.toString() : input.outcome === "AWAY_WIN" ? match.away.teamId.toString() : null;
    let decisionMethod: MatchDecision["decisionMethod"] = "ADMINISTRATIVE";
    let marginType: MatchDecision["marginType"] = null;
    let marginValue: number | null = null;
    if (input.outcome !== "NO_RESULT" && isLimitedTwoInnings) {
      if (innings.length !== 2 || innings.some((row) => row.status !== "COMPLETED")) throw new AppError(409, "MATCH_INNINGS_INCOMPLETE", "Both limited-overs innings must be complete before result adjudication");
      const homeRuns = innings.filter((row) => row.battingTeamId.equals(match.home.teamId)).reduce((sum, row) => sum + row.runs, 0);
      const awayRuns = innings.filter((row) => row.battingTeamId.equals(match.away.teamId)).reduce((sum, row) => sum + row.runs, 0);
      const expectedOutcome = homeRuns === awayRuns ? "TIE" : homeRuns > awayRuns ? "HOME_WIN" : "AWAY_WIN";
      const needsAdministrativeTiebreak = expectedOutcome === "TIE" && ["SUPER_OVER", "REPLAY"].includes(match.rules.tiePolicy);
      if (!needsAdministrativeTiebreak && input.outcome !== expectedOutcome) throw new AppError(409, "MATCH_RESULT_SCORE_MISMATCH", "The selected result does not match completed innings scores", { homeRuns, awayRuns, expectedOutcome });
      if (needsAdministrativeTiebreak) {
        decisionMethod = "ADMINISTRATIVE";
      } else {
        decisionMethod = "SCORECARD";
      }
      if (expectedOutcome !== "TIE") {
        const chasingTeamId = innings[1]!.battingTeamId.toString();
        if (winnerTeamId === chasingTeamId) {
          marginType = "WICKETS";
          marginValue = Math.max(0, match.rules.playersPerSide - 1 - innings[1]!.wickets);
        } else {
          marginType = "RUNS";
          marginValue = Math.abs(homeRuns - awayRuns);
        }
      }
    }
    return finalizeMatchAndStandings(session, tenantId, tournamentId, matchId, {
      outcome: input.outcome, winnerTeamId, marginType, marginValue, decisionMethod,
    }, { type: "USER", id: actorId }, input.reason, requestId);
  });
}

export async function closeInnings(tenantId: string, tournamentId: string, matchId: string, inningsNumber: number, actorId: string, requestId: string, input: { expectedInningsVersion: number; reason: string }) {
  if (!validId(matchId)) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  return withTransaction(async (session: ClientSession) => {
    const match = await Match.findOne({ _id: matchId, tenantId, tournamentId, status: "LIVE" }).session(session);
    if (!match) throw new AppError(404, "LIVE_MATCH_NOT_FOUND", "Live match was not found");
    const innings = await Innings.findOne({ tenantId, matchId, number: inningsNumber }).session(session);
    if (!innings) throw new AppError(404, "INNINGS_NOT_FOUND", "Innings was not found");
    if (innings.aggregateVersion !== input.expectedInningsVersion) throw new AppError(409, "STALE_INNINGS_VERSION", "Innings changed; reload before retrying", { currentVersion: innings.aggregateVersion });
    if (innings.status !== "LIVE") throw new AppError(409, "INNINGS_ALREADY_CLOSED", "Innings is already complete");
    innings.status = "COMPLETED";
    innings.closureType = "MANUAL";
    innings.leaseExpiresAt = null;
    innings.scorerUserId = null;
    innings.aggregateVersion += 1;
    await innings.save({ session });
    match.aggregateVersion += 1;
    await match.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "match.innings.closed", outcome: "SUCCEEDED", resourceType: "match_innings", resourceId: innings.id, requestId, reason: input.reason, metadata: { matchId, inningsNumber, runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "match.innings.completed", schemaVersion: 1, aggregateType: "match_innings", aggregateId: innings.id, aggregateVersion: innings.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId, tournamentId, inningsNumber, runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls, status: innings.status } }, session);
    await enqueuePublicMatchSnapshotNotice(session, tenantId, tournamentId, match.id, match.aggregateVersion);
    return toInningsSnapshot(innings as unknown as Parameters<typeof toInningsSnapshot>[0]);
  });
}

export async function startNextInnings(tenantId: string, tournamentId: string, matchId: string, actorId: string, requestId: string, input: { expectedMatchVersion: number; battingTeamId: string }) {
  if (!validId(matchId)) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  return withTransaction(async (session: ClientSession) => {
    const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).session(session);
    if (!match || match.status !== "LIVE") throw new AppError(404, "LIVE_MATCH_NOT_FOUND", "Live match was not found");
    if (match.aggregateVersion !== input.expectedMatchVersion) throw new AppError(409, "STALE_MATCH_VERSION", "Match changed; reload before retrying", { currentVersion: match.aggregateVersion });
    const prior = await Innings.findOne({ tenantId, matchId, number: match.currentInningsNumber }).session(session);
    if (!prior || prior.status !== "COMPLETED") throw new AppError(409, "PREVIOUS_INNINGS_ACTIVE", "Complete the current innings before starting the next innings");
    const nextNumber = match.currentInningsNumber + 1;
    if (nextNumber > match.rules.inningsPerMatch) throw new AppError(409, "MATCH_INNINGS_LIMIT_REACHED", "The configured innings count has been reached");
    const homeId = match.home.teamId.toString();
    const awayId = match.away.teamId.toString();
    if (![homeId, awayId].includes(input.battingTeamId)) throw new AppError(400, "INVALID_BATTING_TEAM", "Batting team must be one of the match teams");
    if (match.rules.format !== "TEST" && match.rules.inningsPerMatch === 2 && input.battingTeamId === match.firstBattingTeamId?.toString()) throw new AppError(409, "INVALID_INNINGS_ORDER", "The second limited-overs innings must be played by the opposing team");
    const bowlingTeamId = input.battingTeamId === homeId ? awayId : homeId;
    const [innings] = await Innings.create([{ tenantId, tournamentId, matchId, number: nextNumber, battingTeamId: input.battingTeamId, bowlingTeamId, status: "LIVE", eventHead: 0, extras: {} }], { session });
    if (!innings) throw new Error("Next innings creation returned no record");
    match.currentInningsNumber = nextNumber;
    match.aggregateVersion += 1;
    await match.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "match.innings.started", outcome: "SUCCEEDED", resourceType: "match", resourceId: match.id, requestId, metadata: { inningsNumber: nextNumber, battingTeamId: input.battingTeamId } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "match.innings.started", schemaVersion: 1, aggregateType: "match", aggregateId: match.id, aggregateVersion: match.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId: match.id, tournamentId, inningsNumber: nextNumber, battingTeamId: input.battingTeamId, status: "LIVE" } }, session);
    await enqueuePublicMatchSnapshotNotice(session, tenantId, tournamentId, match.id, match.aggregateVersion);
    return { match: snapshotMatch(match as unknown as Parameters<typeof snapshotMatch>[0]), innings: toInningsSnapshot(innings as unknown as Parameters<typeof toInningsSnapshot>[0]) };
  });
}

export async function isMatchAdministrator(tenantId: string, userId: string, session?: ClientSession): Promise<boolean> {
  const query = Membership.findOne({ tenantId, userId, status: "ACTIVE", role: { $in: ["OWNER", "ADMIN"] } });
  if (session) query.session(session);
  return Boolean(await query.select("_id"));
}

export function isValidMatchId(value: string): boolean { return validId(value); }
