import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { Membership } from "../memberships/models/membership.model.js";
import { PlayerRegistration } from "../registrations/models/player-registration.model.js";
import { Tournament } from "../tournaments/models/tournament.model.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { TeamStaff } from "./models/team-staff.model.js";
import { Team } from "./models/team.model.js";
import { RosterEntry } from "../rosters/models/roster-entry.model.js";
import type { AddRosterEntryInput, CreateTeamInput, ReleaseRosterEntryInput } from "./team.schemas.js";
import { Auction } from "../auctions/models/auction.model.js";
import { assertWithinQuota } from "../usage/usage.service.js";

type TeamDoc = { _id: Types.ObjectId; tenantId: Types.ObjectId; tournamentId: Types.ObjectId; name: string; slug: string; shortName: string; status: string; aggregateVersion: number; createdAt: Date };
const teamDto = (team: TeamDoc) => ({ id: team._id.toString(), tenantId: team.tenantId.toString(), tournamentId: team.tournamentId.toString(), name: team.name, slug: team.slug, shortName: team.shortName, status: team.status, version: team.aggregateVersion, createdAt: team.createdAt });
const rosterDto = (entry: { _id: Types.ObjectId; teamId: Types.ObjectId; playerProfileId: Types.ObjectId; registrationId: Types.ObjectId; source: string; status: string; assignedAt: Date; releasedAt: Date | null; aggregateVersion: number; history?: unknown[]; registrationProfile?: Record<string, unknown> }) => ({ id: entry._id.toString(), teamId: entry.teamId.toString(), playerProfileId: entry.playerProfileId.toString(), registrationId: entry.registrationId.toString(), source: entry.source, status: entry.status, assignedAt: entry.assignedAt, releasedAt: entry.releasedAt, version: entry.aggregateVersion, history: entry.history ?? [], profile: entry.registrationProfile ?? null });
const validId = (id: string) => Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);

export async function createTeam(tenantId: string, tournamentId: string, creatorId: string, requestId: string, input: CreateTeamInput) {
  try {
    return await withTransaction(async (session: ClientSession) => {
      const tournament = await Tournament.findOne({ _id: tournamentId, tenantId }).session(session);
      if (!tournament) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
      if (!["DRAFT", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(tournament.status)) throw new AppError(409, "TEAMS_LOCKED", "Teams can only be created before the tournament is scheduled");
      await assertWithinQuota(tenantId, "teamsPerTournament", session, (activeSession) => Team.countDocuments({ tenantId, tournamentId, status: "ACTIVE" }).session(activeSession));
      const [team] = await Team.create([{ tenantId, tournamentId, ...input, createdById: creatorId, status: "ACTIVE", aggregateVersion: 1 }], { session });
      if (!team) throw new Error("Team creation returned no record");
      await TeamStaff.create([{ tenantId, tournamentId, teamId: team._id, userId: creatorId, roles: ["OWNER"], status: "ACTIVE", assignedById: creatorId }], { session });
      tournament.aggregateVersion += 1;
      await tournament.save({ session });
      await recordAudit({ actorType: "USER", actorId: creatorId, tenantId, action: "team.created", outcome: "SUCCEEDED", resourceType: "team", resourceId: team.id, requestId, metadata: { tournamentId, slug: team.slug, tournamentVersion: tournament.aggregateVersion } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "team.created", schemaVersion: 1, aggregateType: "team", aggregateId: team.id, aggregateVersion: 1, visibility: "TENANT_PRIVATE", data: { teamId: team.id, tournamentId, name: team.name, slug: team.slug } }, session);
      return teamDto(team as unknown as TeamDoc);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "TEAM_SLUG_TAKEN", "That team URL is already in use in this tournament");
    throw error;
  }
}

export async function listTeams(tenantId: string, tournamentId: string) {
  const teams = await Team.find({ tenantId, tournamentId }).sort({ name: 1, _id: 1 }).lean();
  return teams.map((team) => teamDto(team as unknown as TeamDoc));
}

export async function getTeam(tenantId: string, tournamentId: string, teamId: string) {
  if (!validId(teamId)) throw new AppError(404, "TEAM_NOT_FOUND", "Team was not found");
  const team = await Team.findOne({ _id: teamId, tenantId, tournamentId }).lean();
  if (!team) throw new AppError(404, "TEAM_NOT_FOUND", "Team was not found");
  return teamDto(team as unknown as TeamDoc);
}

export async function assignTeamStaff(tenantId: string, tournamentId: string, teamId: string, actorId: string, requestId: string, userId: string, role: "MANAGER" | "BIDDER") {
  if (!validId(teamId) || !validId(userId)) throw new AppError(404, "TEAM_OR_USER_NOT_FOUND", "Team or user was not found");
  return withTransaction(async (session: ClientSession) => {
    const team = await Team.findOne({ _id: teamId, tenantId, tournamentId, status: "ACTIVE" }).session(session);
    if (!team) throw new AppError(404, "TEAM_NOT_FOUND", "Team was not found");
    const membership = await Membership.findOne({ tenantId, userId, status: "ACTIVE" }).session(session);
    if (!membership) throw new AppError(404, "TENANT_MEMBER_NOT_FOUND", "User is not an active member of this organization");
    let staff = await TeamStaff.findOne({ teamId, userId }).session(session);
    if (staff && staff.status === "ACTIVE" && staff.roles.includes(role)) return { teamId, userId, roles: staff.roles, status: staff.status };
    if (staff) {
      staff.status = "ACTIVE";
      staff.roles = [...new Set([...staff.roles, role])];
      staff.assignedById = new Types.ObjectId(actorId);
      staff.assignedAt = new Date();
      await staff.save({ session });
    } else {
      [staff] = await TeamStaff.create([{ tenantId, tournamentId, teamId, userId, roles: [role], status: "ACTIVE", assignedById: actorId }], { session });
    }
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "team.staff.assigned", outcome: "SUCCEEDED", resourceType: "team", resourceId: teamId, requestId, metadata: { userId, role } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "team.staff.assigned", schemaVersion: 1, aggregateType: "team", aggregateId: teamId, aggregateVersion: team.aggregateVersion, visibility: "TENANT_PRIVATE", data: { teamId, userId, role } }, session);
    return { teamId, userId, roles: staff?.roles ?? [role], status: "ACTIVE" };
  });
}

export async function listTeamStaff(tenantId: string, tournamentId: string, teamId: string) {
  if (!validId(teamId)) throw new AppError(404, "TEAM_NOT_FOUND", "Team was not found");
  const rows = await TeamStaff.find({ tenantId, tournamentId, teamId, status: "ACTIVE" }).populate({ path: "userId", select: "displayName email" }).sort({ assignedAt: 1 }).lean();
  return rows.map((row) => {
    const user = row.userId as unknown as { _id: Types.ObjectId; displayName: string; email: string } | null;
    return user ? { user: { id: user._id.toString(), displayName: user.displayName, email: user.email }, roles: row.roles, assignedAt: row.assignedAt } : null;
  }).filter((row) => row !== null);
}

export async function listTeamRoster(tenantId: string, tournamentId: string, teamId: string, includeReleased: boolean) {
  if (!validId(teamId)) throw new AppError(404, "TEAM_NOT_FOUND", "Team was not found");
  const query = { tenantId, tournamentId, teamId, ...(includeReleased ? {} : { status: "ACTIVE" }) };
  const rows = await RosterEntry.find(query).populate({ path: "registrationId", select: "profileSnapshot" }).sort({ assignedAt: 1 }).lean();
  return rows.map((row) => {
    const registration = row.registrationId as unknown as { _id: Types.ObjectId; profileSnapshot: Record<string, unknown> } | null;
    return rosterDto({ ...row, registrationId: registration?._id ?? row.registrationId, registrationProfile: registration?.profileSnapshot ?? undefined } as unknown as Parameters<typeof rosterDto>[0]);
  });
}

export async function addRosterEntry(tenantId: string, tournamentId: string, teamId: string, actorId: string, requestId: string, input: AddRosterEntryInput) {
  if (!validId(teamId) || !validId(input.registrationId)) throw new AppError(404, "TEAM_OR_REGISTRATION_NOT_FOUND", "Team or application was not found");
  try {
    return await withTransaction(async (session: ClientSession) => {
      const team = await Team.findOne({ _id: teamId, tenantId, tournamentId, status: "ACTIVE" }).session(session);
      if (!team) throw new AppError(404, "TEAM_NOT_FOUND", "Team was not found");
      const tournament = await Tournament.findOne({ _id: tournamentId, tenantId }).session(session);
      if (!tournament) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
      if (!["REGISTRATION_CLOSED", "SCHEDULED"].includes(tournament.status)) throw new AppError(409, "ROSTER_LOCKED", "Direct roster assignments require closed registration and must happen before live play");
      if (await Auction.exists({ tenantId, tournamentId, status: { $ne: "CANCELLED" } }).session(session)) throw new AppError(409, "AUCTION_ROSTER_LOCKED", "Direct roster changes are locked while an auction is active");
      const registration = await PlayerRegistration.findOne({ _id: input.registrationId, tenantId, tournamentId, status: "APPROVED" }).session(session);
      if (!registration) throw new AppError(409, "APPROVED_REGISTRATION_REQUIRED", "Only an approved tournament application can be assigned directly");
      const existing = await RosterEntry.findOne({ tenantId, tournamentId, playerProfileId: registration.playerProfileId }).session(session);
      if (existing?.status === "ACTIVE") {
        if (existing.teamId.toString() === teamId && existing.registrationId.toString() === input.registrationId) return rosterDto(existing as unknown as Parameters<typeof rosterDto>[0]);
        throw new AppError(409, "PLAYER_ALREADY_ROSTERED", "This player already has an active roster entry in this tournament");
      }
      if (team.aggregateVersion !== input.expectedVersion) throw new AppError(409, "STALE_TEAM_VERSION", "Team roster changed; reload before retrying", { currentVersion: team.aggregateVersion });
      if (existing && !input.reason) throw new AppError(400, "ROSTER_REASSIGNMENT_REASON_REQUIRED", "Provide a reason when restoring or transferring a released player");
      const rules = tournament.rules as { maximumSquadSize?: number };
      const maxSize = Number(rules?.maximumSquadSize ?? 30);
      const activeCount = await RosterEntry.countDocuments({ tenantId, tournamentId, teamId, status: "ACTIVE" }).session(session);
      if (activeCount >= maxSize) throw new AppError(409, "SQUAD_LIMIT_REACHED", "The team has reached the configured maximum squad size");
      team.aggregateVersion += 1;
      await team.save({ session });
      tournament.aggregateVersion += 1;
      await tournament.save({ session });
      const now = new Date();
      let entry;
      if (existing) {
        const priorTeamId = existing.teamId;
        existing.teamId = new Types.ObjectId(teamId);
        existing.registrationId = registration._id;
        existing.source = "DIRECT_REGISTRATION";
        existing.status = "ACTIVE";
        existing.assignedAt = now;
        existing.releasedAt = null;
        existing.aggregateVersion += 1;
        existing.history.push({ action: priorTeamId.toString() === teamId ? "ASSIGNED" : "TRANSFERRED", fromTeamId: priorTeamId, toTeamId: team._id, actorId: new Types.ObjectId(actorId), reason: input.reason ?? null, occurredAt: now });
        await existing.save({ session });
        entry = existing;
      } else {
        const [created] = await RosterEntry.create([{
          tenantId, tournamentId, teamId: team._id, playerProfileId: registration.playerProfileId, registrationId: registration._id,
          source: "DIRECT_REGISTRATION", status: "ACTIVE", assignedAt: now, aggregateVersion: 1,
          history: [{ action: "ASSIGNED", fromTeamId: null, toTeamId: team._id, actorId, reason: input.reason ?? null, occurredAt: now }],
        }], { session });
        if (!created) throw new Error("Roster entry creation returned no record");
        entry = created;
      }
      await recordAudit({ actorType: "USER", actorId, tenantId, action: existing ? "team.roster.reassigned" : "team.roster.assigned", outcome: "SUCCEEDED", resourceType: "roster_entry", resourceId: entry.id, requestId, reason: input.reason, metadata: { teamId, tournamentId, playerProfileId: registration.playerProfileId.toString(), tournamentVersion: tournament.aggregateVersion } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: existing ? "team.roster.reassigned" : "team.roster.assigned", schemaVersion: 1, aggregateType: "roster_entry", aggregateId: entry.id, aggregateVersion: entry.aggregateVersion, visibility: "TENANT_PRIVATE", data: { rosterEntryId: entry.id, teamId, tournamentId, playerProfileId: registration.playerProfileId.toString(), status: entry.status, tournamentVersion: tournament.aggregateVersion } }, session);
      return rosterDto(entry as unknown as Parameters<typeof rosterDto>[0]);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "PLAYER_ALREADY_ROSTERED", "This player already has a roster entry in this tournament");
    throw error;
  }
}

export async function releaseRosterEntry(tenantId: string, tournamentId: string, teamId: string, playerProfileId: string, actorId: string, requestId: string, input: ReleaseRosterEntryInput) {
  if (!validId(teamId) || !validId(playerProfileId)) throw new AppError(404, "ROSTER_ENTRY_NOT_FOUND", "Roster entry was not found");
  return withTransaction(async (session: ClientSession) => {
    const team = await Team.findOne({ _id: teamId, tenantId, tournamentId, status: "ACTIVE" }).session(session);
    if (!team) throw new AppError(404, "TEAM_NOT_FOUND", "Team was not found");
    const tournament = await Tournament.findOne({ _id: tournamentId, tenantId }).session(session);
    if (!tournament) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
    if (!["REGISTRATION_CLOSED", "SCHEDULED"].includes(tournament.status)) throw new AppError(409, "ROSTER_LOCKED", "Roster changes are locked after live play begins");
    if (await Auction.exists({ tenantId, tournamentId, status: { $ne: "CANCELLED" } }).session(session)) throw new AppError(409, "AUCTION_ROSTER_LOCKED", "Direct roster changes are locked while an auction is active");
    const entry = await RosterEntry.findOne({ tenantId, tournamentId, teamId, playerProfileId, status: "ACTIVE" }).session(session);
    if (!entry) throw new AppError(404, "ROSTER_ENTRY_NOT_FOUND", "Active roster entry was not found");
    if (entry.aggregateVersion !== input.expectedVersion) throw new AppError(409, "STALE_ROSTER_VERSION", "Roster entry changed; reload before retrying", { currentVersion: entry.aggregateVersion });
    const rules = tournament.rules as { minimumSquadSize?: number };
    const minimumSquadSize = Number(rules?.minimumSquadSize ?? 1);
    const activeCount = await RosterEntry.countDocuments({ tenantId, tournamentId, teamId, status: "ACTIVE" }).session(session);
    if (activeCount <= minimumSquadSize) throw new AppError(409, "MINIMUM_SQUAD_SIZE_REQUIRED", "A player cannot be released if the team would fall below the configured minimum squad size");
    const now = new Date();
    entry.status = "RELEASED";
    entry.releasedAt = now;
    entry.aggregateVersion += 1;
    entry.history.push({ action: "RELEASED", fromTeamId: team._id, toTeamId: null, actorId: new Types.ObjectId(actorId), reason: input.reason, occurredAt: now });
    team.aggregateVersion += 1;
    tournament.aggregateVersion += 1;
    await entry.save({ session });
    await team.save({ session });
    await tournament.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "team.roster.released", outcome: "SUCCEEDED", resourceType: "roster_entry", resourceId: entry.id, requestId, reason: input.reason, metadata: { teamId, tournamentId, playerProfileId, tournamentVersion: tournament.aggregateVersion } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "team.roster.released", schemaVersion: 1, aggregateType: "roster_entry", aggregateId: entry.id, aggregateVersion: entry.aggregateVersion, visibility: "TENANT_PRIVATE", data: { rosterEntryId: entry.id, teamId, tournamentId, playerProfileId, status: entry.status, tournamentVersion: tournament.aggregateVersion } }, session);
    return rosterDto(entry as unknown as Parameters<typeof rosterDto>[0]);
  });
}
