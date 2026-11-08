import type { ClientSession } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { PlayerProfile } from "./models/player-profile.model.js";
import type { CreatePlayerProfileInput, UpdatePlayerProfileInput } from "./player.schemas.js";

function toProfileDto(profile: { id: string; displayName: string; bio: string; locationLabel: string; playingRole: string; battingHand: string; bowlingStyle: string; wicketkeeper: boolean; preferredFormats: string[]; visibility: string; aggregateVersion: number; createdAt: Date; updatedAt: Date }) {
  return { id: profile.id, displayName: profile.displayName, bio: profile.bio, locationLabel: profile.locationLabel, playingRole: profile.playingRole, battingHand: profile.battingHand, bowlingStyle: profile.bowlingStyle, wicketkeeper: profile.wicketkeeper, preferredFormats: profile.preferredFormats, visibility: profile.visibility, version: profile.aggregateVersion, createdAt: profile.createdAt, updatedAt: profile.updatedAt };
}

export async function createPlayerProfile(userId: string, requestId: string, input: CreatePlayerProfileInput) {
  try {
    return await withTransaction(async (session: ClientSession) => {
      const [profile] = await PlayerProfile.create([{
        userId, displayName: input.displayName, bio: input.bio, locationLabel: input.locationLabel,
        playingRole: input.playingRole, battingHand: input.battingHand, bowlingStyle: input.bowlingStyle,
        wicketkeeper: input.wicketkeeper, preferredFormats: input.preferredFormats, visibility: input.visibility,
        consentedAt: new Date(), consentVersion: "player-profile-v1", aggregateVersion: 1,
      }], { session });
      if (!profile) throw new Error("Player profile creation returned no record");
      await recordAudit({ actorType: "USER", actorId: userId, action: "player_profile.created", outcome: "SUCCEEDED", resourceType: "player_profile", resourceId: profile.id, requestId, metadata: { visibility: profile.visibility } }, session);
      await enqueueOutboxEvent({ eventType: "player_profile.created", schemaVersion: 1, aggregateType: "player_profile", aggregateId: profile.id, aggregateVersion: 1, visibility: profile.visibility === "PUBLIC" ? "PUBLIC" : "INTERNAL", data: { profileId: profile.id, displayName: profile.displayName, visibility: profile.visibility } }, session);
      return toProfileDto(profile);
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "PLAYER_PROFILE_EXISTS", "This account already has a player profile");
    throw error;
  }
}

export async function getMyPlayerProfile(userId: string) {
  const profile = await PlayerProfile.findOne({ userId, status: "ACTIVE" }).lean();
  if (!profile) throw new AppError(404, "PLAYER_PROFILE_NOT_FOUND", "Create a player profile before applying to a tournament");
  return toProfileDto({ id: profile._id.toString(), ...profile });
}

export async function updateMyPlayerProfile(userId: string, requestId: string, input: UpdatePlayerProfileInput) {
  return withTransaction(async (session: ClientSession) => {
    const profile = await PlayerProfile.findOne({ userId, status: "ACTIVE" }).session(session);
    if (!profile) throw new AppError(404, "PLAYER_PROFILE_NOT_FOUND", "Player profile was not found");
    if (profile.aggregateVersion !== input.expectedVersion) throw new AppError(409, "STALE_PROFILE_VERSION", "Profile changed; reload before saving", { currentVersion: profile.aggregateVersion });
    profile.displayName = input.displayName;
    profile.bio = input.bio;
    profile.locationLabel = input.locationLabel;
    profile.playingRole = input.playingRole;
    profile.battingHand = input.battingHand;
    profile.bowlingStyle = input.bowlingStyle;
    profile.wicketkeeper = input.wicketkeeper;
    profile.preferredFormats = input.preferredFormats;
    profile.visibility = input.visibility;
    profile.consentedAt = new Date();
    profile.consentVersion = "player-profile-v1";
    profile.aggregateVersion += 1;
    await profile.save({ session });
    await recordAudit({ actorType: "USER", actorId: userId, action: "player_profile.updated", outcome: "SUCCEEDED", resourceType: "player_profile", resourceId: profile.id, requestId, metadata: { version: profile.aggregateVersion, visibility: profile.visibility } }, session);
    await enqueueOutboxEvent({ eventType: "player_profile.updated", schemaVersion: 1, aggregateType: "player_profile", aggregateId: profile.id, aggregateVersion: profile.aggregateVersion, visibility: profile.visibility === "PUBLIC" ? "PUBLIC" : "INTERNAL", data: { profileId: profile.id, version: profile.aggregateVersion, visibility: profile.visibility } }, session);
    return toProfileDto(profile);
  });
}
