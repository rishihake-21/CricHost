import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { PlayerProfile } from "../players/models/player-profile.model.js";
import { Tournament } from "../tournaments/models/tournament.model.js";
import { PlayerRegistration } from "./models/player-registration.model.js";
import type { RegistrationDecision } from "./registration.schemas.js";
import { assertWithinQuota } from "../usage/usage.service.js";

function registrationDto(item: { _id: Types.ObjectId; tenantId: Types.ObjectId; tournamentId: Types.ObjectId; playerProfileId: Types.ObjectId; status: string; profileSnapshot: Record<string, unknown>; appliedAt: Date; reviewedAt: Date | null; reviewedById: Types.ObjectId | null; decisionReason: string | null; aggregateVersion: number }) {
  return { id: item._id.toString(), tenantId: item.tenantId.toString(), tournamentId: item.tournamentId.toString(), playerProfileId: item.playerProfileId.toString(), status: item.status, profile: item.profileSnapshot, appliedAt: item.appliedAt, reviewedAt: item.reviewedAt, reviewedById: item.reviewedById?.toString() ?? null, decisionReason: item.decisionReason, version: item.aggregateVersion };
}

export async function applyToTournament(tenantId: string, tournamentId: string, userId: string, requestId: string) {
  if (!Types.ObjectId.isValid(tournamentId) || !/^[a-f\d]{24}$/i.test(tournamentId)) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
  try {
    return await withTransaction(async (session: ClientSession) => {
      const profile = await PlayerProfile.findOne({ userId, status: "ACTIVE" }).session(session);
      if (!profile) throw new AppError(409, "PLAYER_PROFILE_REQUIRED", "Create an active player profile before applying");
      const tournament = await Tournament.findOne({ _id: tournamentId, tenantId }).session(session);
      if (!tournament || tournament.visibility !== "PUBLIC") throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
      const now = new Date();
      if (tournament.status !== "REGISTRATION_OPEN" || tournament.registrationOpensAt > now || tournament.registrationClosesAt <= now) {
        throw new AppError(409, "REGISTRATION_CLOSED", "This tournament is not accepting applications");
      }
      await assertWithinQuota(tenantId, "registrationsPerTournament", session, (activeSession) => PlayerRegistration.countDocuments({ tenantId, tournamentId }).session(activeSession));
      const profileSnapshot = {
        displayName: profile.displayName,
        bio: profile.bio,
        locationLabel: profile.locationLabel,
        playingRole: profile.playingRole,
        battingHand: profile.battingHand,
        bowlingStyle: profile.bowlingStyle,
        wicketkeeper: profile.wicketkeeper,
        preferredFormats: profile.preferredFormats,
        visibility: profile.visibility,
        profileVersion: profile.aggregateVersion,
      };
      const [registration] = await PlayerRegistration.create([{
        tenantId, tournamentId, playerProfileId: profile._id, applicantUserId: userId,
        profileSnapshot, status: "PENDING_REVIEW", consentedAt: now, consentVersion: "tournament-participation-v1", appliedAt: now, aggregateVersion: 1,
      }], { session });
      if (!registration) throw new Error("Tournament registration returned no record");
      await recordAudit({ actorType: "USER", actorId: userId, tenantId, action: "player_registration.submitted", outcome: "SUCCEEDED", resourceType: "player_registration", resourceId: registration.id, requestId, metadata: { tournamentId, profileId: profile.id } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "player_registration.submitted", schemaVersion: 1, aggregateType: "player_registration", aggregateId: registration.id, aggregateVersion: 1, visibility: "TENANT_PRIVATE", data: { registrationId: registration.id, tournamentId, playerProfileId: profile.id } }, session);
      return registrationDto(registration);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "ALREADY_REGISTERED", "This player already has an application for the tournament");
    throw error;
  }
}

export async function getMyRegistration(tenantId: string, tournamentId: string, userId: string) {
  const registration = await PlayerRegistration.findOne({ tenantId, tournamentId, applicantUserId: userId }).lean();
  if (!registration) throw new AppError(404, "REGISTRATION_NOT_FOUND", "Tournament application was not found");
  return registrationDto(registration as unknown as Parameters<typeof registrationDto>[0]);
}

export async function listTournamentRegistrations(tenantId: string, tournamentId: string, limit: number) {
  const rows = await PlayerRegistration.find({ tenantId, tournamentId }).sort({ appliedAt: 1, _id: 1 }).limit(limit).lean();
  return rows.map((row) => registrationDto(row as unknown as Parameters<typeof registrationDto>[0]));
}

export async function decideRegistration(tenantId: string, tournamentId: string, registrationId: string, reviewerId: string, requestId: string, decision: RegistrationDecision) {
  if (!Types.ObjectId.isValid(registrationId) || !/^[a-f\d]{24}$/i.test(registrationId)) throw new AppError(404, "REGISTRATION_NOT_FOUND", "Tournament application was not found");
  return withTransaction(async (session: ClientSession) => {
    const registration = await PlayerRegistration.findOne({ _id: registrationId, tenantId, tournamentId }).session(session);
    if (!registration) throw new AppError(404, "REGISTRATION_NOT_FOUND", "Tournament application was not found");
    if (registration.status !== "PENDING_REVIEW") throw new AppError(409, "REGISTRATION_ALREADY_REVIEWED", "Only a pending application can be decided");
    const nextStatus = decision.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const reason = decision.decision === "REJECT" ? decision.reason : undefined;
    registration.status = nextStatus;
    registration.reviewedAt = new Date();
    registration.reviewedById = new Types.ObjectId(reviewerId);
    registration.decisionReason = reason ?? null;
    registration.aggregateVersion += 1;
    await registration.save({ session });
    await recordAudit({ actorType: "USER", actorId: reviewerId, tenantId, action: decision.decision === "APPROVE" ? "player_registration.approved" : "player_registration.rejected", outcome: "SUCCEEDED", resourceType: "player_registration", resourceId: registration.id, requestId, reason, metadata: { tournamentId, playerProfileId: registration.playerProfileId.toString() } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: `player_registration.${decision.decision === "APPROVE" ? "approved" : "rejected"}`, schemaVersion: 1, aggregateType: "player_registration", aggregateId: registration.id, aggregateVersion: registration.aggregateVersion, visibility: "TENANT_PRIVATE", data: { registrationId: registration.id, tournamentId, status: registration.status, aggregateVersion: registration.aggregateVersion } }, session);
    return registrationDto(registration);
  });
}
