import { createHash } from "node:crypto";
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { RosterEntry } from "../rosters/models/roster-entry.model.js";
import { Team } from "../teams/models/team.model.js";
import { Tournament } from "../tournaments/models/tournament.model.js";
import { Fixture } from "./models/fixture.model.js";
import { FixtureGeneration } from "./models/fixture-generation.model.js";
import { TournamentStanding } from "./models/standing.model.js";
import type { GenerateFixturesInput } from "./fixture.schemas.js";

type TeamRow = { _id: Types.ObjectId; name: string; slug: string };
type Pairing = { roundNumber: number; home: TeamRow; away: TeamRow };
const algorithm = "fisher-yates-sha256-v1+circle-round-robin-v1";
const validId = (id: string) => Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);

function seededShuffle<T>(items: T[], seed: string): T[] {
  let counter = 0;
  const next = () => createHash("sha256").update(`${seed}\0${counter++}`).digest().readUInt32BE(0);
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = next() % (index + 1);
    [items[index], items[swapIndex]] = [items[swapIndex]!, items[index]!];
  }
  return items;
}

function buildRoundRobin(teams: TeamRow[], seed: string) {
  const ordered = seededShuffle([...teams], seed);
  const slots: (TeamRow | null)[] = [...ordered];
  if (slots.length % 2 === 1) slots.push(null);
  const rounds = slots.length - 1;
  const pairings: Pairing[] = [];
  const byes: Types.ObjectId[][] = [];
  let rotation = [...slots];
  for (let roundIndex = 0; roundIndex < rounds; roundIndex += 1) {
    const roundNumber = roundIndex + 1;
    const roundByes: Types.ObjectId[] = [];
    for (let pairIndex = 0; pairIndex < rotation.length / 2; pairIndex += 1) {
      let left = rotation[pairIndex];
      let right = rotation[rotation.length - 1 - pairIndex];
      if (!left) { if (right) roundByes.push(right._id); continue; }
      if (!right) { roundByes.push(left._id); continue; }
      if ((roundIndex + pairIndex) % 2 === 1) [left, right] = [right, left];
      pairings.push({ roundNumber, home: left, away: right });
    }
    byes.push(roundByes);
    const fixed = rotation[0];
    const moving = rotation.slice(1);
    moving.unshift(moving.pop()!);
    rotation = [fixed!, ...moving];
  }
  return { ordered, pairings, byes };
}

function fixtureDto(row: { _id: Types.ObjectId; fixtureNumber: number; roundNumber: number; home: { teamId: Types.ObjectId; name: string; slug: string; seed: number }; away: { teamId: Types.ObjectId; name: string; slug: string; seed: number }; startsAt: Date; durationMinutes: number; status: string; scheduleVersion: number; aggregateVersion: number }) {
  return { id: row._id.toString(), fixtureNumber: row.fixtureNumber, roundNumber: row.roundNumber, home: { teamId: row.home.teamId.toString(), name: row.home.name, slug: row.home.slug, seed: row.home.seed }, away: { teamId: row.away.teamId.toString(), name: row.away.name, slug: row.away.slug, seed: row.away.seed }, startsAt: row.startsAt, durationMinutes: row.durationMinutes, status: row.status, scheduleVersion: row.scheduleVersion, version: row.aggregateVersion };
}

export async function generateFixtures(tenantId: string, tournamentId: string, actorId: string, requestId: string, input: GenerateFixturesInput) {
  if (!validId(tournamentId)) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  try {
    return await withTransaction(async (session: ClientSession) => {
      const tournament = await Tournament.findOne({ _id: tournamentId, tenantId }).session(session);
      if (!tournament) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
      if (tournament.aggregateVersion !== input.expectedTournamentVersion) throw new AppError(409, "STALE_TOURNAMENT_VERSION", "Tournament changed; reload before retrying", { currentVersion: tournament.aggregateVersion });
      if (tournament.status !== "REGISTRATION_CLOSED") throw new AppError(409, "FIXTURE_GENERATION_LOCKED", "Fixtures can only be generated after registration closes and before scheduling");
      if (tournament.structure !== "ROUND_ROBIN") throw new AppError(409, "FIXTURE_STRUCTURE_UNSUPPORTED", "The first fixture generator supports round-robin tournaments; knockout and group-knockout brackets are not yet enabled");
      const priorGeneration = await FixtureGeneration.findOne({ tenantId, tournamentId }).session(session);
      if (priorGeneration) throw new AppError(409, "FIXTURES_ALREADY_GENERATED", "Fixtures already exist; schedule changes must use the versioned change workflow");

      const activeTeams = await Team.find({ tenantId, tournamentId, status: "ACTIVE" }).select("_id name slug").sort({ slug: 1, _id: 1 }).session(session).lean();
      if (activeTeams.length < 2) throw new AppError(409, "INSUFFICIENT_TEAMS", "At least two active teams are required to generate fixtures");
      const rosterCounts = await RosterEntry.aggregate([{ $match: { tenantId: new Types.ObjectId(tenantId), tournamentId: new Types.ObjectId(tournamentId), status: "ACTIVE" } }, { $group: { _id: "$teamId", rosterSize: { $sum: 1 } } }]).session(session);
      const countByTeam = new Map<string, number>(rosterCounts.map((row: { _id: Types.ObjectId; rosterSize: number }): [string, number] => [row._id.toString(), row.rosterSize]));
      const minimumSquadSize = Number((tournament.rules as { minimumSquadSize?: number }).minimumSquadSize ?? 1);
      const underfilled = activeTeams.filter((team) => (countByTeam.get(team._id.toString()) ?? 0) < minimumSquadSize);
      if (underfilled.length) throw new AppError(409, "TEAM_ROSTER_INCOMPLETE", "Every active team must meet the tournament minimum squad size before scheduling", { teams: underfilled.map((team) => ({ teamId: team._id.toString(), rosterSize: countByTeam.get(team._id.toString()) ?? 0, minimumSquadSize })) });

      const scheduleStartAt = new Date(input.scheduleStartAt);
      if (scheduleStartAt < tournament.startAt) throw new AppError(400, "SCHEDULE_OUTSIDE_TOURNAMENT", "The first fixture cannot start before the tournament start date");
      const { ordered, pairings, byes } = buildRoundRobin(activeTeams as unknown as TeamRow[], input.seed);
      const scheduledRows = pairings.map((pairing, index) => {
        const startsAt = new Date(scheduleStartAt.getTime() + index * input.intervalMinutes * 60_000);
        const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
        if (endsAt > tournament.endAt) throw new AppError(400, "SCHEDULE_OUTSIDE_TOURNAMENT", "The generated fixture schedule extends beyond the tournament end date");
        return {
          tenantId, tournamentId, fixtureNumber: index + 1, roundNumber: pairing.roundNumber,
          home: { teamId: pairing.home._id, name: pairing.home.name, slug: pairing.home.slug, seed: ordered.findIndex((team) => team._id.equals(pairing.home._id)) + 1 },
          away: { teamId: pairing.away._id, name: pairing.away.name, slug: pairing.away.slug, seed: ordered.findIndex((team) => team._id.equals(pairing.away._id)) + 1 },
          startsAt, durationMinutes: input.durationMinutes, status: "SCHEDULED", scheduleVersion: 1, aggregateVersion: 1,
        };
      });
      const generatedAt = new Date();
      const [generation] = await FixtureGeneration.create([{
        tenantId, tournamentId, seed: input.seed, algorithm, sourceTournamentVersion: tournament.aggregateVersion,
        generatedById: actorId, generatedAt,
        teamSnapshot: ordered.map((team, index) => ({ teamId: team._id, name: team.name, slug: team.slug, seed: index + 1, rosterSize: countByTeam.get(team._id.toString()) ?? 0 })),
        byeTeamIdsByRound: byes, intervalMinutes: input.intervalMinutes, durationMinutes: input.durationMinutes, scheduleStartAt, aggregateVersion: 1,
      }], { session });
      if (!generation) throw new Error("Fixture generation returned no record");
      const fixtures = await Fixture.create(scheduledRows, { session });
      await TournamentStanding.create(ordered.map((team) => ({ tenantId, tournamentId, teamId: team._id, teamName: team.name, aggregateVersion: 1, updatedAt: generatedAt })), { session });

      tournament.status = "SCHEDULED";
      tournament.aggregateVersion += 1;
      await tournament.save({ session });
      await recordAudit({ actorType: "USER", actorId, tenantId, action: "tournament.fixtures.generated", outcome: "SUCCEEDED", resourceType: "tournament", resourceId: tournament.id, requestId, metadata: { fixtureCount: fixtures.length, teamCount: ordered.length, seed: input.seed, algorithm, sourceTournamentVersion: generation.sourceTournamentVersion } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "tournament.fixtures.generated", schemaVersion: 1, aggregateType: "tournament", aggregateId: tournament.id, aggregateVersion: tournament.aggregateVersion, visibility: tournament.visibility === "PUBLIC" ? "PUBLIC" : "TENANT_PRIVATE", data: { tournamentId, fixtureGenerationId: generation.id, fixtureCount: fixtures.length, teamCount: ordered.length, scheduleVersion: 1 } }, session);
      return { generation: { id: generation.id, seed: generation.seed, algorithm: generation.algorithm, sourceTournamentVersion: generation.sourceTournamentVersion, teamCount: ordered.length, fixtureCount: fixtures.length, byeTeamIdsByRound: generation.byeTeamIdsByRound.map((round: Types.ObjectId[]) => round.map((teamId) => teamId.toString())), generatedAt }, fixtures: fixtures.map((fixture) => fixtureDto(fixture as unknown as Parameters<typeof fixtureDto>[0])) };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "FIXTURES_ALREADY_GENERATED", "Fixtures already exist; schedule changes must use the versioned change workflow");
    throw error;
  }
}

export async function listFixtures(tenantId: string, tournamentId: string) {
  if (!validId(tournamentId)) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  const rows = await Fixture.find({ tenantId, tournamentId }).sort({ roundNumber: 1, fixtureNumber: 1 }).lean();
  return rows.map((row) => fixtureDto(row as unknown as Parameters<typeof fixtureDto>[0]));
}

export async function getStandings(tenantId: string, tournamentId: string) {
  if (!validId(tournamentId)) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  const rows = await TournamentStanding.find({ tenantId, tournamentId }).sort({ points: -1, netRunRate: -1, teamName: 1 }).lean();
  return rows.map((row, index) => ({ rank: index + 1, teamId: row.teamId.toString(), teamName: row.teamName, played: row.played, won: row.won, lost: row.lost, tied: row.tied, noResult: row.noResult, points: row.points, runsFor: row.runsFor, ballsFaced: row.ballsFaced, runsAgainst: row.runsAgainst, ballsBowled: row.ballsBowled, netRunRate: row.netRunRate, version: row.aggregateVersion, updatedAt: row.updatedAt }));
}
