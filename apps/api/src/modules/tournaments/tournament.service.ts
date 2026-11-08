import { Types } from "mongoose";
import type { ClientSession } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { Tournament } from "./models/tournament.model.js";
import { createTournamentSchema, type CreateTournamentInput, type TournamentRules } from "./tournament.schemas.js";

const dto = (item: { _id: Types.ObjectId; name: string; slug: string; season: string; description: string; timezone: string; locale: string; visibility: string; registrationOpensAt: Date; registrationClosesAt: Date; startAt: Date; endAt: Date; format: string; structure: string; rulesVersion: number; rules: unknown; status: string; aggregateVersion: number; createdAt: Date }) => ({
  id: item._id.toString(), name: item.name, slug: item.slug, season: item.season,
  description: item.description, timezone: item.timezone, locale: item.locale,
  visibility: item.visibility, registrationOpensAt: item.registrationOpensAt,
  registrationClosesAt: item.registrationClosesAt, startAt: item.startAt, endAt: item.endAt,
  format: item.format, structure: item.structure, rulesVersion: item.rulesVersion,
  rules: item.rules, status: item.status, version: item.aggregateVersion, createdAt: item.createdAt,
});

export async function createTournament(tenantId: string, userId: string, requestId: string, input: CreateTournamentInput) {
  try {
    return await withTransaction(async (session: ClientSession) => {
      const [tournament] = await Tournament.create([{
        tenantId, createdById: userId,
        ...input,
        registrationOpensAt: new Date(input.registrationOpensAt),
        registrationClosesAt: new Date(input.registrationClosesAt),
        startAt: new Date(input.startAt), endAt: new Date(input.endAt),
        rulesVersion: 1, aggregateVersion: 1, status: "DRAFT",
      }], { session });
      if (!tournament) throw new Error("Tournament creation returned no record");
      await recordAudit({ actorType: "USER", actorId: userId, tenantId, action: "tournament.created", outcome: "SUCCEEDED", resourceType: "tournament", resourceId: tournament.id, requestId, metadata: { slug: tournament.slug, format: tournament.format, structure: tournament.structure } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "tournament.created", schemaVersion: 1, aggregateType: "tournament", aggregateId: tournament.id, aggregateVersion: 1, visibility: tournament.visibility === "PUBLIC" ? "PUBLIC" : "TENANT_PRIVATE", data: { tournamentId: tournament.id, name: tournament.name, slug: tournament.slug, format: tournament.format } }, session);
      return dto(tournament);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "TOURNAMENT_SLUG_TAKEN", "That tournament URL is already in use in this organization");
    throw error;
  }
}

export async function listTournaments(tenantId: string, limit: number) {
  const rows = await Tournament.find({ tenantId }).sort({ startAt: -1, _id: -1 }).limit(limit).lean();
  return rows.map((item) => dto(item as unknown as Parameters<typeof dto>[0]));
}

export async function getTournament(tenantId: string, tournamentId: string) {
  if (!Types.ObjectId.isValid(tournamentId) || !/^[a-f\d]{24}$/i.test(tournamentId)) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  const item = await Tournament.findOne({ _id: tournamentId, tenantId }).lean();
  if (!item) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  return dto(item as unknown as Parameters<typeof dto>[0]);
}

export async function updateTournamentRules(tenantId: string, tournamentId: string, userId: string, requestId: string, expectedVersion: number, rules: TournamentRules) {
  if (!Types.ObjectId.isValid(tournamentId) || !/^[a-f\d]{24}$/i.test(tournamentId)) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  return withTransaction(async (session: ClientSession) => {
    const current = await Tournament.findOne({ _id: tournamentId, tenantId }).session(session);
    if (!current) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
    if (current.status !== "DRAFT") throw new AppError(409, "TOURNAMENT_RULES_LOCKED", "Rules can only change while a tournament is in draft");
    if (current.aggregateVersion !== expectedVersion) throw new AppError(409, "STALE_TOURNAMENT_VERSION", "Tournament changed; reload before retrying", { currentVersion: current.aggregateVersion });
    const compatible = createTournamentSchema.safeParse({
      name: current.name, slug: current.slug, season: current.season, description: current.description,
      timezone: current.timezone, locale: current.locale, visibility: current.visibility,
      registrationOpensAt: current.registrationOpensAt.toISOString(), registrationClosesAt: current.registrationClosesAt.toISOString(),
      startAt: current.startAt.toISOString(), endAt: current.endAt.toISOString(), format: current.format, structure: current.structure, rules,
    });
    if (!compatible.success) throw new AppError(400, "INVALID_RULES_FOR_FORMAT", "Rules are not valid for this tournament format", { issues: compatible.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
    current.rules = rules;
    current.rulesVersion += 1;
    current.aggregateVersion += 1;
    await current.save({ session });
    await recordAudit({ actorType: "USER", actorId: userId, tenantId, action: "tournament.rules.updated", outcome: "SUCCEEDED", resourceType: "tournament", resourceId: current.id, requestId, metadata: { rulesVersion: current.rulesVersion, aggregateVersion: current.aggregateVersion } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "tournament.rules.updated", schemaVersion: 1, aggregateType: "tournament", aggregateId: current.id, aggregateVersion: current.aggregateVersion, visibility: "TENANT_PRIVATE", data: { tournamentId: current.id, rulesVersion: current.rulesVersion } }, session);
    return dto(current);
  });
}

export async function transitionTournament(tenantId: string, tournamentId: string, userId: string, requestId: string, targetStatus: "REGISTRATION_OPEN" | "REGISTRATION_CLOSED", reason?: string) {
  if (!Types.ObjectId.isValid(tournamentId) || !/^[a-f\d]{24}$/i.test(tournamentId)) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  return withTransaction(async (session: ClientSession) => {
    const current = await Tournament.findOne({ _id: tournamentId, tenantId }).session(session);
    if (!current) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
    const now = new Date();
    if (targetStatus === "REGISTRATION_OPEN") {
      if (current.status !== "DRAFT") throw new AppError(409, "INVALID_TOURNAMENT_TRANSITION", "Only a draft tournament can open registration");
      if (current.registrationOpensAt > now) throw new AppError(409, "REGISTRATION_NOT_OPEN_YET", "Registration open time has not arrived");
    } else {
      if (current.status !== "REGISTRATION_OPEN") throw new AppError(409, "INVALID_TOURNAMENT_TRANSITION", "Only an open registration can be closed");
      if (current.registrationClosesAt > now && !reason) throw new AppError(409, "EARLY_CLOSE_REASON_REQUIRED", "Provide a reason to close registration before its configured end time");
    }
    const fromStatus = current.status;
    current.status = targetStatus;
    current.aggregateVersion += 1;
    await current.save({ session });
    await recordAudit({ actorType: "USER", actorId: userId, tenantId, action: "tournament.lifecycle.changed", outcome: "SUCCEEDED", resourceType: "tournament", resourceId: current.id, requestId, reason, metadata: { fromStatus, toStatus: targetStatus, aggregateVersion: current.aggregateVersion } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "tournament.lifecycle.changed", schemaVersion: 1, aggregateType: "tournament", aggregateId: current.id, aggregateVersion: current.aggregateVersion, visibility: current.visibility === "PUBLIC" ? "PUBLIC" : "TENANT_PRIVATE", data: { tournamentId: current.id, fromStatus, toStatus: targetStatus, aggregateVersion: current.aggregateVersion } }, session);
    return dto(current);
  });
}
