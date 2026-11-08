import { createHash } from "node:crypto";
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { recordAudit } from "../audit/audit.service.js";
import { Membership } from "../memberships/models/membership.model.js";
import { Match } from "../matches/models/match.model.js";
import { MatchScorer } from "../matches/models/match-scorer.model.js";
import { enqueuePublicMatchSnapshotNotice, finalizeMatchAndStandings, isMatchAdministrator, isStandardLimitedOversFormat, isValidMatchId } from "../matches/match.service.js";
import { Innings } from "./models/innings.model.js";
import { ScoringEvent } from "./models/scoring-event.model.js";
import type { AppendDeliveryInput, CorrectDeliveryInput } from "../matches/match.schemas.js";

function deliveryHash(input: AppendDeliveryInput): string {
  const canonical = {
    expectedSequence: input.expectedSequence, leaseEpoch: input.leaseEpoch, strikerId: input.strikerId, bowlerId: input.bowlerId,
    deliveryType: input.deliveryType, batRuns: input.batRuns, extraType: input.extraType, extraRuns: input.extraRuns,
    completedRuns: input.completedRuns, dismissalType: input.dismissalType, dismissedPlayerId: input.dismissedPlayerId,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function correctionHash(input: CorrectDeliveryInput): string {
  return createHash("sha256").update(JSON.stringify({
    expectedSequence: input.expectedSequence,
    expectedInningsVersion: input.expectedInningsVersion,
    targetEventId: input.targetEventId,
    reason: input.reason,
    revisedDelivery: input.revisedDelivery,
  })).digest("hex");
}

type DeliveryAttribution = { strikerId: string; bowlerId: string; dismissedPlayerId: string | null };
function assertMatchRosterAttribution(match: {
  home: { teamId: Types.ObjectId }; away: { teamId: Types.ObjectId };
  homeRosterProfileIds: Types.ObjectId[]; awayRosterProfileIds: Types.ObjectId[];
}, innings: { battingTeamId: Types.ObjectId; bowlingTeamId: Types.ObjectId }, delivery: DeliveryAttribution): void {
  const battingRoster = new Set((innings.battingTeamId.equals(match.home.teamId) ? match.homeRosterProfileIds : match.awayRosterProfileIds).map((id: Types.ObjectId) => id.toString()));
  const bowlingRoster = new Set((innings.bowlingTeamId.equals(match.home.teamId) ? match.homeRosterProfileIds : match.awayRosterProfileIds).map((id: Types.ObjectId) => id.toString()));
  if (!battingRoster.has(delivery.strikerId)) throw new AppError(400, "STRIKER_NOT_ON_MATCH_ROSTER", "Striker must be on the frozen batting roster for this match");
  if (!bowlingRoster.has(delivery.bowlerId)) throw new AppError(400, "BOWLER_NOT_ON_MATCH_ROSTER", "Bowler must be on the frozen bowling roster for this match");
  if (delivery.dismissedPlayerId && !battingRoster.has(delivery.dismissedPlayerId)) throw new AppError(400, "DISMISSED_PLAYER_NOT_ON_MATCH_ROSTER", "Dismissed player must be on the frozen batting roster for this match");
}

type StoredDelivery = {
  deliveryType: "LEGAL" | "WIDE" | "NO_BALL"; batRuns: number; extraType: "NONE" | "WIDE" | "NO_BALL" | "BYE" | "LEG_BYE"; extraRuns: number; dismissalType: string | null;
};
type ScoringHistoryRow = {
  _id: Types.ObjectId; sequence: number; type: "DELIVERY" | "CORRECTION";
  delivery?: StoredDelivery | null;
  correction?: { targetEventId: Types.ObjectId; revisedDelivery: StoredDelivery } | null;
};

function rebuildProjection(events: ScoringHistoryRow[], playersPerSide: number, oversPerInnings: number | null, ballsPerOver: number) {
  const effectiveById = new Map<string, StoredDelivery>();
  const deliveryIds: string[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.sequence !== index + 1) throw new AppError(409, "SCORING_HISTORY_GAP", "Scoring history cannot be rebuilt because event sequences are incomplete");
    if (event.type === "DELIVERY" && event.delivery) {
      const id = event._id.toString();
      effectiveById.set(id, event.delivery);
      deliveryIds.push(id);
    } else if (event.type === "CORRECTION" && event.correction) {
      const targetId = event.correction.targetEventId.toString();
      if (!effectiveById.has(targetId)) throw new AppError(409, "SCORING_CORRECTION_TARGET_INVALID", "Scoring history contains a correction without an earlier delivery target");
      effectiveById.set(targetId, event.correction.revisedDelivery);
    } else {
      throw new AppError(409, "SCORING_EVENT_INVALID", "Scoring history contains an invalid event shape");
    }
  }

  const projection = { runs: 0, wickets: 0, legalBalls: 0, extras: { wides: 0, noBalls: 0, byes: 0, legByes: 0 } };
  for (const id of deliveryIds) {
    const delivery = effectiveById.get(id)!;
    projection.runs += delivery.batRuns + delivery.extraRuns;
    if (delivery.dismissalType) projection.wickets += 1;
    if (delivery.deliveryType === "LEGAL") projection.legalBalls += 1;
    if (delivery.extraType === "WIDE") projection.extras.wides += delivery.extraRuns;
    if (delivery.extraType === "NO_BALL") projection.extras.noBalls += delivery.extraRuns;
    if (delivery.extraType === "BYE") projection.extras.byes += delivery.extraRuns;
    if (delivery.extraType === "LEG_BYE") projection.extras.legByes += delivery.extraRuns;
  }
  const maxLegalBalls = oversPerInnings === null ? null : oversPerInnings * ballsPerOver;
  if (projection.wickets > playersPerSide - 1 || (maxLegalBalls !== null && projection.legalBalls > maxLegalBalls)) {
    throw new AppError(409, "SCORING_CORRECTION_BREAKS_INNINGS_LIMIT", "The revised delivery would exceed the innings wicket or overs limit");
  }
  return { ...projection, automaticallyComplete: projection.wickets >= playersPerSide - 1 || (maxLegalBalls !== null && projection.legalBalls >= maxLegalBalls) };
}

function deliveryDetailsDto(data: Record<string, unknown>) {
  const idString = (value: unknown) => value instanceof Types.ObjectId ? value.toString() : String(value);
  return {
    strikerId: idString(data.strikerId), bowlerId: idString(data.bowlerId), deliveryType: data.deliveryType,
    batRuns: data.batRuns, extraType: data.extraType, extraRuns: data.extraRuns, completedRuns: data.completedRuns,
    dismissalType: data.dismissalType ?? null, dismissedPlayerId: data.dismissedPlayerId ? idString(data.dismissedPlayerId) : null,
  };
}

function deliveryDto(event: {
  _id: Types.ObjectId; inningsNumber: number; sequence: number; clientEventId: string; leaseEpoch: number; type: string;
  delivery: Record<string, unknown> | null;
  correction: { targetEventId: Types.ObjectId | string; targetSequence: number; reason: string; revisedDelivery: Record<string, unknown> } | null;
  totalRuns: number; legalBall: boolean; createdById: Types.ObjectId; occurredAt: Date;
}) {
  return {
    id: event._id.toString(), inningsNumber: event.inningsNumber, sequence: event.sequence, clientEventId: event.clientEventId,
    leaseEpoch: event.leaseEpoch, type: event.type,
    delivery: event.delivery ? deliveryDetailsDto(event.delivery) : null,
    correction: event.correction ? { targetEventId: event.correction.targetEventId.toString(), targetSequence: event.correction.targetSequence, reason: event.correction.reason, revisedDelivery: deliveryDetailsDto(event.correction.revisedDelivery) } : null,
    totalRuns: event.totalRuns, legalBall: event.legalBall, createdById: event.createdById.toString(), occurredAt: event.occurredAt,
  };
}

async function requireAssignedScorer(tenantId: string, matchId: string, userId: string, session: ClientSession) {
  if (await isMatchAdministrator(tenantId, userId, session)) return;
  const assignment = await MatchScorer.findOne({ tenantId, matchId, userId, status: "ACTIVE" }).session(session).select("_id");
  if (!assignment) throw new AppError(403, "SCORER_NOT_ASSIGNED", "An active match scorer assignment is required");
}

async function requireActiveMembership(tenantId: string, userId: string, session: ClientSession) {
  const membership = await Membership.findOne({ tenantId, userId, status: "ACTIVE" }).session(session).select("_id");
  if (!membership) throw new AppError(403, "ACTIVE_MEMBERSHIP_REQUIRED", "An active organization membership is required for scoring");
}

export async function acquireScorerLease(
  tenantId: string, tournamentId: string, matchId: string, inningsNumber: number, userId: string, requestId: string,
  input: { expectedLeaseEpoch: number; durationSeconds: number; takeoverReason?: string },
) {
  if (!isValidMatchId(matchId)) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  return withTransaction(async (session: ClientSession) => {
    const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).session(session);
    if (!match || match.status !== "LIVE") throw new AppError(404, "LIVE_MATCH_NOT_FOUND", "Live match was not found");
    const innings = await Innings.findOne({ tenantId, matchId, number: inningsNumber }).session(session);
    if (!innings || innings.status !== "LIVE") throw new AppError(404, "LIVE_INNINGS_NOT_FOUND", "Live innings was not found");
    await requireActiveMembership(tenantId, userId, session);
    await requireAssignedScorer(tenantId, matchId, userId, session);
    if (innings.leaseEpoch !== input.expectedLeaseEpoch) throw new AppError(409, "STALE_SCORER_LEASE_EPOCH", "Scorer lease changed; reload before retrying", { currentLeaseEpoch: innings.leaseEpoch });
    const now = new Date();
    const existingLeaseActive = Boolean(innings.scorerUserId && innings.leaseExpiresAt && innings.leaseExpiresAt > now);
    const sameHolder = innings.scorerUserId?.toString() === userId;
    const isAdmin = await isMatchAdministrator(tenantId, userId, session);
    if (existingLeaseActive && !sameHolder && !isAdmin) throw new AppError(403, "SCORER_TAKEOVER_FORBIDDEN", "Only an organization owner or administrator can take over an active scorer lease");
    if (existingLeaseActive && !sameHolder && !input.takeoverReason) throw new AppError(409, "SCORER_TAKEOVER_REASON_REQUIRED", "An owner/admin takeover requires an audit reason", { leaseEpoch: innings.leaseEpoch, leaseExpiresAt: innings.leaseExpiresAt });
    const renewed = existingLeaseActive && sameHolder;
    const takeover = existingLeaseActive && !sameHolder;
    innings.scorerUserId = new Types.ObjectId(userId);
    if (!renewed) innings.leaseEpoch += 1;
    innings.leaseExpiresAt = new Date(now.getTime() + input.durationSeconds * 1000);
    innings.aggregateVersion += 1;
    await innings.save({ session });
    if (!renewed) {
      await recordAudit({ actorType: "USER", actorId: userId, tenantId, action: takeover ? "match.scorer_lease.taken_over" : "match.scorer_lease.acquired", outcome: "SUCCEEDED", resourceType: "match_innings", resourceId: innings.id, requestId, ...(takeover && input.takeoverReason ? { reason: input.takeoverReason } : {}), metadata: { matchId, inningsNumber, leaseEpoch: innings.leaseEpoch } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: takeover ? "match.scorer_lease.taken_over" : "match.scorer_lease.acquired", schemaVersion: 1, aggregateType: "match_innings", aggregateId: innings.id, aggregateVersion: innings.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId, tournamentId, inningsNumber, leaseEpoch: innings.leaseEpoch, leaseExpiresAt: innings.leaseExpiresAt } }, session);
    }
    return { matchId, inningsNumber, leaseEpoch: innings.leaseEpoch, expiresAt: innings.leaseExpiresAt, renewed, takenOver: takeover, version: innings.aggregateVersion };
  });
}

export async function appendDelivery(
  tenantId: string, tournamentId: string, matchId: string, inningsNumber: number, userId: string, requestId: string, input: AppendDeliveryInput,
) {
  if (!isValidMatchId(matchId)) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  const payloadHash = deliveryHash(input);
  try {
    return await withTransaction(async (session: ClientSession) => {
      const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).session(session);
      if (!match) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
      const innings = await Innings.findOne({ tenantId, matchId, number: inningsNumber }).session(session);
      if (!innings) throw new AppError(404, "INNINGS_NOT_FOUND", "Innings was not found");
      const existing = await ScoringEvent.findOne({ tenantId, inningsId: innings._id, clientEventId: input.clientEventId }).select("+eventPayloadHash").session(session);
      if (existing) {
        if (existing.eventPayloadHash !== payloadHash) throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "Client event ID was already used for a different delivery");
        return { event: deliveryDto(existing as unknown as Parameters<typeof deliveryDto>[0]), innings: { runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls, eventHead: innings.eventHead, status: innings.status, version: innings.aggregateVersion }, replayed: true };
      }
      if (match.status !== "LIVE") throw new AppError(409, "MATCH_NOT_LIVE", "Deliveries can only be appended to a live match");
      if (innings.status !== "LIVE") throw new AppError(409, "INNINGS_COMPLETE", "No more deliveries can be recorded in a completed innings");
      if (input.expectedSequence !== innings.eventHead) throw new AppError(409, "STALE_EVENT_HEAD", "Scoring history changed; reload the innings before retrying", { currentSequence: innings.eventHead, currentVersion: innings.aggregateVersion });
      if (input.leaseEpoch !== innings.leaseEpoch || innings.scorerUserId?.toString() !== userId || !innings.leaseExpiresAt || innings.leaseExpiresAt <= new Date()) {
        throw new AppError(409, "SCORER_LEASE_INVALID", "The scorer lease is missing, expired or fenced by a newer scorer", { currentLeaseEpoch: innings.leaseEpoch, leaseExpiresAt: innings.leaseExpiresAt });
      }
      await requireActiveMembership(tenantId, userId, session);
      await requireAssignedScorer(tenantId, matchId, userId, session);
      if (innings.wickets >= match.rules.playersPerSide - 1) throw new AppError(409, "INNINGS_ALL_OUT", "All wickets have already fallen");
      const maxLegalBalls = match.rules.oversPerInnings === null ? null : Number(match.rules.oversPerInnings) * Number(match.rules.ballsPerOver);
      if (maxLegalBalls !== null && innings.legalBalls >= maxLegalBalls) throw new AppError(409, "INNINGS_OVERS_COMPLETE", "The configured overs limit has been reached");

      assertMatchRosterAttribution(match, innings, input);

      const totalRuns = input.batRuns + input.extraRuns;
      const legalBall = input.deliveryType === "LEGAL";
      const nextLegalBalls = innings.legalBalls + (legalBall ? 1 : 0);
      const nextWickets = innings.wickets + (input.dismissalType ? 1 : 0);
      let chasingWon = false;
      if (isStandardLimitedOversFormat(match.rules.format) && match.rules.inningsPerMatch === 2 && innings.number === 2) {
        const firstInnings = await Innings.findOne({ tenantId, matchId, number: 1 }).session(session);
        chasingWon = Boolean(firstInnings && innings.runs + totalRuns > firstInnings.runs);
      }
      const inningsComplete = chasingWon || nextWickets >= match.rules.playersPerSide - 1 || (maxLegalBalls !== null && nextLegalBalls >= maxLegalBalls);
      const [event] = await ScoringEvent.create([{
        tenantId, tournamentId, matchId, inningsId: innings._id, inningsNumber, sequence: innings.eventHead + 1,
        clientEventId: input.clientEventId, eventPayloadHash: payloadHash, leaseEpoch: input.leaseEpoch, type: "DELIVERY",
        delivery: {
          strikerId: input.strikerId, bowlerId: input.bowlerId, deliveryType: input.deliveryType, batRuns: input.batRuns,
          extraType: input.extraType, extraRuns: input.extraRuns, completedRuns: input.completedRuns,
          dismissalType: input.dismissalType, dismissedPlayerId: input.dismissedPlayerId,
        },
        totalRuns, legalBall, createdById: userId, occurredAt: new Date(),
      }], { session });
      if (!event) throw new Error("Scoring event append returned no record");
      innings.runs += totalRuns;
      innings.wickets = nextWickets;
      innings.legalBalls = nextLegalBalls;
      if (input.extraType === "WIDE") innings.extras.wides += input.extraRuns;
      if (input.extraType === "NO_BALL") innings.extras.noBalls += input.extraRuns;
      if (input.extraType === "BYE") innings.extras.byes += input.extraRuns;
      if (input.extraType === "LEG_BYE") innings.extras.legByes += input.extraRuns;
      innings.eventHead += 1;
      innings.aggregateVersion += 1;
      if (inningsComplete) {
        innings.status = "COMPLETED";
        innings.closureType = "AUTOMATIC";
        innings.scorerUserId = null;
        innings.leaseExpiresAt = null;
      }
      await innings.save({ session });
      await enqueueOutboxEvent({ tenantId, eventType: "match.delivery.accepted", schemaVersion: 1, aggregateType: "match_innings", aggregateId: innings.id, aggregateVersion: innings.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId, tournamentId, inningsNumber, sequence: event.sequence, totalRuns, wickets: innings.wickets, runs: innings.runs, legalBalls: innings.legalBalls, status: innings.status } }, session);
      if (chasingWon) {
        const winnerTeamId = innings.battingTeamId.toString();
        await finalizeMatchAndStandings(session, tenantId, tournamentId, matchId, {
          outcome: match.home.teamId.equals(innings.battingTeamId) ? "HOME_WIN" : "AWAY_WIN",
          winnerTeamId,
          marginType: "WICKETS",
          marginValue: Math.max(0, match.rules.playersPerSide - 1 - innings.wickets),
          decisionMethod: "SCORECARD",
        }, { type: "SYSTEM" }, "Chasing team reached the target during the second innings", requestId);
      } else {
        match.aggregateVersion += 1;
        await match.save({ session });
        await enqueuePublicMatchSnapshotNotice(session, tenantId, tournamentId, match.id, match.aggregateVersion);
      }
      return { event: deliveryDto(event as unknown as Parameters<typeof deliveryDto>[0]), innings: { runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls, eventHead: innings.eventHead, status: innings.status, version: innings.aggregateVersion }, replayed: false };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      const existing = await ScoringEvent.findOne({ tenantId, matchId, inningsNumber, clientEventId: input.clientEventId }).select("+eventPayloadHash");
      if (existing) {
        if (existing.eventPayloadHash !== payloadHash) throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "Client event ID was already used for a different delivery");
        const innings = await Innings.findOne({ tenantId, matchId, number: inningsNumber });
        return { event: deliveryDto(existing as unknown as Parameters<typeof deliveryDto>[0]), innings: innings ? { runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls, eventHead: innings.eventHead, status: innings.status, version: innings.aggregateVersion } : null, replayed: true };
      }
    }
    throw error;
  }
}

export async function correctDelivery(
  tenantId: string, tournamentId: string, matchId: string, inningsNumber: number, actorId: string, requestId: string, input: CorrectDeliveryInput,
) {
  if (!isValidMatchId(matchId)) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  const payloadHash = correctionHash(input);
  try {
    return await withTransaction(async (session: ClientSession) => {
      const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).session(session);
      if (!match) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
      const innings = await Innings.findOne({ tenantId, matchId, number: inningsNumber }).session(session);
      if (!innings) throw new AppError(404, "INNINGS_NOT_FOUND", "Innings was not found");
      const existing = await ScoringEvent.findOne({ tenantId, inningsId: innings._id, clientEventId: input.clientEventId }).select("+eventPayloadHash").session(session);
      if (existing) {
        if (existing.type !== "CORRECTION" || existing.eventPayloadHash !== payloadHash) throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "Client event ID was already used for a different scoring event");
        return { event: deliveryDto(existing as unknown as Parameters<typeof deliveryDto>[0]), innings: { runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls, eventHead: innings.eventHead, status: innings.status, version: innings.aggregateVersion }, replayed: true };
      }
      if (match.status !== "LIVE") throw new AppError(409, "MATCH_NOT_LIVE", "A scoring correction can only be appended while the match is live");
      if (!await isMatchAdministrator(tenantId, actorId, session)) throw new AppError(403, "PERMISSION_DENIED", "Organization owner/admin permission is required to correct a delivery");
      await requireActiveMembership(tenantId, actorId, session);
      if (input.expectedSequence !== innings.eventHead || input.expectedInningsVersion !== innings.aggregateVersion) {
        throw new AppError(409, "STALE_SCORING_VERSION", "Scoring changed; reload the innings before correcting it", { currentSequence: innings.eventHead, currentVersion: innings.aggregateVersion });
      }
      const target = await ScoringEvent.findOne({ _id: input.targetEventId, tenantId, inningsId: innings._id, type: "DELIVERY" }).session(session);
      if (!target || target.sequence > innings.eventHead) throw new AppError(404, "DELIVERY_EVENT_NOT_FOUND", "Original delivery event was not found in this innings");
      assertMatchRosterAttribution(match, innings, input.revisedDelivery);
      const [event] = await ScoringEvent.create([{
        tenantId, tournamentId, matchId, inningsId: innings._id, inningsNumber, sequence: innings.eventHead + 1,
        clientEventId: input.clientEventId, eventPayloadHash: payloadHash, leaseEpoch: innings.leaseEpoch, type: "CORRECTION",
        delivery: null,
        correction: { targetEventId: target._id, targetSequence: target.sequence, reason: input.reason, revisedDelivery: input.revisedDelivery },
        totalRuns: 0, legalBall: false, createdById: actorId, occurredAt: new Date(),
      }], { session });
      if (!event) throw new Error("Scoring correction append returned no record");
      const history = await ScoringEvent.find({ tenantId, inningsId: innings._id }).sort({ sequence: 1 }).session(session).lean();
      const projection = rebuildProjection(
        history as unknown as ScoringHistoryRow[], match.rules.playersPerSide, match.rules.oversPerInnings, match.rules.ballsPerOver,
      );
      const wasManuallyClosed = innings.closureType === "MANUAL";
      const shouldComplete = wasManuallyClosed || projection.automaticallyComplete;
      if (projection.automaticallyComplete && !wasManuallyClosed && innings.status === "LIVE" && innings.scorerUserId) {
        innings.leaseEpoch += 1;
      }
      innings.runs = projection.runs;
      innings.wickets = projection.wickets;
      innings.legalBalls = projection.legalBalls;
      innings.extras.wides = projection.extras.wides;
      innings.extras.noBalls = projection.extras.noBalls;
      innings.extras.byes = projection.extras.byes;
      innings.extras.legByes = projection.extras.legByes;
      innings.eventHead += 1;
      innings.aggregateVersion += 1;
      innings.status = shouldComplete ? "COMPLETED" : "LIVE";
      if (wasManuallyClosed) {
        innings.closureType = "MANUAL";
      } else if (projection.automaticallyComplete) {
        innings.closureType = "AUTOMATIC";
      } else {
        innings.closureType = null;
      }
      if (shouldComplete) {
        innings.scorerUserId = null;
        innings.leaseExpiresAt = null;
      }
      await innings.save({ session });
      match.aggregateVersion += 1;
      await match.save({ session });
      await enqueuePublicMatchSnapshotNotice(session, tenantId, tournamentId, match.id, match.aggregateVersion);
      await recordAudit({ actorType: "USER", actorId, tenantId, action: "match.delivery.corrected", outcome: "SUCCEEDED", resourceType: "scoring_event", resourceId: event.id, requestId, reason: input.reason, metadata: { matchId, inningsNumber, targetEventId: target.id, targetSequence: target.sequence, correctionSequence: event.sequence } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "match.delivery.corrected", schemaVersion: 1, aggregateType: "match_innings", aggregateId: innings.id, aggregateVersion: innings.aggregateVersion, visibility: "TENANT_PRIVATE", data: { matchId, tournamentId, inningsNumber, sequence: event.sequence, targetSequence: target.sequence, runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls, status: innings.status } }, session);
      return { event: deliveryDto(event as unknown as Parameters<typeof deliveryDto>[0]), innings: { runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls, eventHead: innings.eventHead, status: innings.status, version: innings.aggregateVersion }, replayed: false };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      const existing = await ScoringEvent.findOne({ tenantId, matchId, inningsNumber, clientEventId: input.clientEventId }).select("+eventPayloadHash");
      if (existing) {
        if (existing.type !== "CORRECTION" || existing.eventPayloadHash !== payloadHash) throw new AppError(409, "IDEMPOTENCY_KEY_REUSED", "Client event ID was already used for a different scoring event");
        const innings = await Innings.findOne({ tenantId, matchId, number: inningsNumber });
        return { event: deliveryDto(existing as unknown as Parameters<typeof deliveryDto>[0]), innings: innings ? { runs: innings.runs, wickets: innings.wickets, legalBalls: innings.legalBalls, eventHead: innings.eventHead, status: innings.status, version: innings.aggregateVersion } : null, replayed: true };
      }
    }
    throw error;
  }
}

export async function listDeliveryEvents(tenantId: string, tournamentId: string, matchId: string, inningsNumber: number, afterSequence: number, limit: number) {
  if (!isValidMatchId(matchId)) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  const match = await Match.findOne({ _id: matchId, tenantId, tournamentId }).select("_id").lean();
  if (!match) throw new AppError(404, "MATCH_NOT_FOUND", "Match was not found");
  const innings = await Innings.findOne({ tenantId, matchId, number: inningsNumber }).select("_id").lean();
  if (!innings) throw new AppError(404, "INNINGS_NOT_FOUND", "Innings was not found");
  const events = await ScoringEvent.find({ tenantId, inningsId: innings._id, sequence: { $gt: afterSequence } }).sort({ sequence: 1 }).limit(limit).lean();
  return { events: events.map((event) => deliveryDto(event as unknown as Parameters<typeof deliveryDto>[0])), nextAfterSequence: events.length === limit ? events[events.length - 1]?.sequence ?? afterSequence : null };
}
