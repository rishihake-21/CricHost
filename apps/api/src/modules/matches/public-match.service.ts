import { Types, type ClientSession } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { Innings } from "../scoring/models/innings.model.js";
import { Tournament } from "../tournaments/models/tournament.model.js";
import { Match } from "./models/match.model.js";

const validId = (id: string) => Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);

type PublicMatchRow = {
  _id: Types.ObjectId;
  tournamentId: Types.ObjectId;
  fixtureId: Types.ObjectId;
  fixtureNumber: number;
  roundNumber: number;
  home: { teamId: Types.ObjectId; name: string; slug: string; seed: number };
  away: { teamId: Types.ObjectId; name: string; slug: string; seed: number };
  scheduledAt: Date;
  rules: { format: string; oversPerInnings: number | null; ballsPerOver: number; playersPerSide: number };
  status: string;
  tossWinnerTeamId: Types.ObjectId | null;
  tossDecision: string | null;
  currentInningsNumber: number;
  startedAt: Date | null;
  completedAt: Date | null;
  result: { outcome: string; winnerTeamId: Types.ObjectId | null; marginType: string | null; marginValue: number | null; decidedAt: Date } | null;
  aggregateVersion: number;
};

type PublicInningsRow = {
  _id: Types.ObjectId;
  number: number;
  battingTeamId: Types.ObjectId;
  bowlingTeamId: Types.ObjectId;
  status: string;
  runs: number;
  wickets: number;
  legalBalls: number;
  extras: { wides: number; noBalls: number; byes: number; legByes: number };
  eventHead: number;
  aggregateVersion: number;
};

function publicMatchDto(match: PublicMatchRow) {
  return {
    id: match._id.toString(),
    tournamentId: match.tournamentId.toString(),
    fixtureId: match.fixtureId.toString(),
    fixtureNumber: match.fixtureNumber,
    roundNumber: match.roundNumber,
    home: { id: match.home.teamId.toString(), name: match.home.name, slug: match.home.slug, seed: match.home.seed },
    away: { id: match.away.teamId.toString(), name: match.away.name, slug: match.away.slug, seed: match.away.seed },
    scheduledAt: match.scheduledAt,
    rules: {
      format: match.rules.format,
      oversPerInnings: match.rules.oversPerInnings,
      ballsPerOver: match.rules.ballsPerOver,
      playersPerSide: match.rules.playersPerSide,
    },
    status: match.status,
    toss: match.tossWinnerTeamId ? { winnerTeamId: match.tossWinnerTeamId.toString(), decision: match.tossDecision } : null,
    currentInningsNumber: match.currentInningsNumber,
    startedAt: match.startedAt,
    completedAt: match.completedAt,
    result: match.result ? {
      outcome: match.result.outcome,
      winnerTeamId: match.result.winnerTeamId?.toString() ?? null,
      marginType: match.result.marginType,
      marginValue: match.result.marginValue,
      decidedAt: match.result.decidedAt,
    } : null,
    version: match.aggregateVersion,
  };
}

function publicInningsDto(innings: PublicInningsRow) {
  return {
    number: innings.number,
    battingTeamId: innings.battingTeamId.toString(),
    bowlingTeamId: innings.bowlingTeamId.toString(),
    status: innings.status,
    score: {
      runs: innings.runs,
      wickets: innings.wickets,
      legalBalls: innings.legalBalls,
      extras: {
        wides: innings.extras.wides,
        noBalls: innings.extras.noBalls,
        byes: innings.extras.byes,
        legByes: innings.extras.legByes,
      },
    },
    eventHead: innings.eventHead,
    version: innings.aggregateVersion,
  };
}

async function findPublicTournament(tournamentId: string, session: ClientSession) {
  if (!validId(tournamentId)) throw new AppError(404, "PUBLIC_MATCH_NOT_FOUND", "Public match was not found");
  const tournament = await Tournament.findOne({ _id: tournamentId, visibility: "PUBLIC" }).select("_id tenantId").session(session);
  if (!tournament) throw new AppError(404, "PUBLIC_MATCH_NOT_FOUND", "Public match was not found");
  return tournament;
}

const matchProjection = "tournamentId fixtureId fixtureNumber roundNumber home away scheduledAt rules.format rules.oversPerInnings rules.ballsPerOver rules.playersPerSide status tossWinnerTeamId tossDecision currentInningsNumber startedAt completedAt result aggregateVersion";
const inningsProjection = "matchId number battingTeamId bowlingTeamId status runs wickets legalBalls extras eventHead aggregateVersion";

export async function getPublicMatchSnapshot(tournamentId: string, matchId: string) {
  if (!validId(matchId)) throw new AppError(404, "PUBLIC_MATCH_NOT_FOUND", "Public match was not found");
  return withTransaction(async (session) => {
    const tournament = await findPublicTournament(tournamentId, session);
    const match = await Match.findOne({ _id: matchId, tournamentId: tournament._id, tenantId: tournament.tenantId })
      .select(matchProjection).session(session).lean();
    if (!match) throw new AppError(404, "PUBLIC_MATCH_NOT_FOUND", "Public match was not found");
    const innings = await Innings.find({ tenantId: tournament.tenantId, tournamentId: tournament._id, matchId: match._id })
      .select(inningsProjection).sort({ number: 1 }).session(session).lean();
    const snapshotAt = new Date();
    return {
      match: publicMatchDto(match as unknown as PublicMatchRow),
      innings: innings.map((row) => publicInningsDto(row as unknown as PublicInningsRow)),
      snapshotAt,
    };
  });
}

export async function listPublicMatches(tournamentId: string, limit: number, afterFixtureNumber = 0) {
  return withTransaction(async (session) => {
    const tournament = await findPublicTournament(tournamentId, session);
    const rows = await Match.find({
      tenantId: tournament.tenantId,
      tournamentId: tournament._id,
      ...(afterFixtureNumber > 0 ? { fixtureNumber: { $gt: afterFixtureNumber } } : {}),
    }).select(matchProjection).sort({ fixtureNumber: 1 }).limit(limit + 1).session(session).lean();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const innings = page.length ? await Innings.find({ tenantId: tournament.tenantId, tournamentId: tournament._id, matchId: { $in: page.map((row) => row._id) } })
      .select(inningsProjection).sort({ matchId: 1, number: 1 }).session(session).lean() : [];
    const inningsByMatch = new Map<string, typeof innings>();
    for (const row of innings) {
      const key = row.matchId.toString();
      const bucket = inningsByMatch.get(key) ?? [];
      bucket.push(row);
      inningsByMatch.set(key, bucket);
    }
    const snapshotAt = new Date();
    return {
      matches: page.map((row) => ({
        match: publicMatchDto(row as unknown as PublicMatchRow),
        innings: (inningsByMatch.get(row._id.toString()) ?? []).map((inningsRow) => publicInningsDto(inningsRow as unknown as PublicInningsRow)),
      })),
      nextAfterFixtureNumber: hasMore ? page.at(-1)?.fixtureNumber ?? null : null,
      snapshotAt,
    };
  });
}
