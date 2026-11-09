import bcrypt from "bcryptjs";
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { Session } from "../identity/models/session.model.js";
import { User } from "../identity/models/user.model.js";
import { PlatformAdmin } from "./models/platform-admin.model.js";
import { createTotpUri, decryptMfaSecret, encryptMfaSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, verifyTotpCode } from "./mfa.crypto.js";
import { env } from "../../platform/config/env.js";

const stepUpDurationMs = 5 * 60_000;

function assertAllowlisted(userId: string): void {
  if (!env.platformAdminUserIds.includes(userId.toLowerCase())) throw new AppError(403, "PLATFORM_ADMIN_REQUIRED", "Platform administrator access is required");
}

export async function getPlatformMfaStatus(userId: string) {
  assertAllowlisted(userId);
  const admin = await PlatformAdmin.findOne({ userId }).select("status mfaEnabledAt +pendingMfaExpiresAt +pendingMfaPurpose").lean();
  if (admin?.status === "DISABLED") return { status: "DISABLED" as const, enabledAt: null };
  if (admin?.pendingMfaExpiresAt && admin.pendingMfaExpiresAt > new Date()) {
    if (admin.pendingMfaPurpose === "REPLACEMENT") return { status: "REPLACEMENT_PENDING" as const, enabledAt: admin.mfaEnabledAt ?? null };
    return { status: "ENROLLMENT_PENDING" as const, enabledAt: null };
  }
  if (admin?.mfaEnabledAt) return { status: "ENABLED" as const, enabledAt: admin.mfaEnabledAt };
  return { status: "NOT_CONFIGURED" as const, enabledAt: null };
}

export async function beginPlatformMfaEnrollment(userId: string, password: string, requestId: string) {
  assertAllowlisted(userId);
  if (Buffer.byteLength(password, "utf8") > 72) throw new AppError(400, "VALIDATION_FAILED", "Password confirmation is invalid");
  const user = await User.findOne({ _id: userId, status: "ACTIVE" }).select("+passwordHash email emailVerifiedAt");
  const passwordMatches = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !passwordMatches) throw new AppError(401, "INVALID_CREDENTIALS", "Password confirmation failed");
  if (!user.emailVerifiedAt) throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify the administrator account before setting up MFA");

  const secret = generateTotpSecret();
  const encryptedSecret = encryptMfaSecret(secret);
  const pendingMfaExpiresAt = new Date(Date.now() + 10 * 60_000);
  await withTransaction(async (session: ClientSession) => {
    const admin = await PlatformAdmin.findOne({ userId }).session(session);
    if (admin?.status === "DISABLED") throw new AppError(403, "PLATFORM_ADMIN_DISABLED", "Platform administrator access is disabled");
    if (admin?.mfaEnabledAt) throw new AppError(409, "PLATFORM_MFA_ALREADY_ENABLED", "MFA is already enabled; use the replacement flow after verifying a second factor");
    if (admin) {
      admin.pendingMfaSecretEncrypted = encryptedSecret;
      admin.pendingMfaExpiresAt = pendingMfaExpiresAt;
      admin.pendingMfaPurpose = "ENROLLMENT";
      admin.pendingMfaSessionId = null;
      admin.aggregateVersion += 1;
      await admin.save({ session });
    } else {
      await PlatformAdmin.create([{ userId, status: "ACTIVE", pendingMfaSecretEncrypted: encryptedSecret, pendingMfaExpiresAt, pendingMfaPurpose: "ENROLLMENT" }], { session });
    }
    await recordAudit({ actorType: "USER", actorId: userId, action: "platform_admin.mfa.enrollment_started", outcome: "SUCCEEDED", resourceType: "platform_admin", resourceId: userId, requestId, metadata: { expiresAt: pendingMfaExpiresAt } }, session);
  });

  return { secret, otpauthUri: createTotpUri(user.email, secret), expiresAt: pendingMfaExpiresAt };
}

export async function confirmPlatformMfaEnrollment(userId: string, code: string, requestId: string) {
  assertAllowlisted(userId);
  return withTransaction(async (session: ClientSession) => {
    const now = new Date();
    const admin = await PlatformAdmin.findOne({ userId, status: "ACTIVE", mfaEnabledAt: null, pendingMfaPurpose: { $in: ["ENROLLMENT", null] }, pendingMfaExpiresAt: { $gt: now } })
      .select("+pendingMfaSecretEncrypted +pendingMfaPurpose +lastAcceptedTotpStep +recoveryCodeHashes")
      .session(session);
    if (!admin?.pendingMfaSecretEncrypted) throw new AppError(409, "PLATFORM_MFA_ENROLLMENT_EXPIRED", "Start a new MFA enrollment before confirming");

    const secret = decryptMfaSecret(admin.pendingMfaSecretEncrypted);
    const acceptedStep = verifyTotpCode(secret, code, now.getTime());
    if (acceptedStep === null) throw new AppError(401, "PLATFORM_MFA_CODE_INVALID", "The authenticator code is invalid or expired");

    const recoveryCodes = generateRecoveryCodes();
    admin.mfaSecretEncrypted = admin.pendingMfaSecretEncrypted;
    admin.pendingMfaSecretEncrypted = null;
    admin.pendingMfaExpiresAt = null;
    admin.pendingMfaPurpose = null;
    admin.pendingMfaSessionId = null;
    admin.mfaEnabledAt = now;
    admin.lastAcceptedTotpStep = acceptedStep;
    admin.recoveryCodeHashes = recoveryCodes.map((recoveryCode) => {
      const hash = hashRecoveryCode(recoveryCode);
      if (!hash) throw new Error("Generated platform recovery code is invalid");
      return hash;
    });
    admin.aggregateVersion += 1;
    await admin.save({ session });
    await recordAudit({ actorType: "USER", actorId: userId, action: "platform_admin.mfa.enabled", outcome: "SUCCEEDED", resourceType: "platform_admin", resourceId: userId, requestId, metadata: { recoveryCodeCount: recoveryCodes.length } }, session);
    return { enabledAt: now, recoveryCodes };
  });
}

export async function beginPlatformMfaReplacement(userId: string, currentSessionId: string, password: string, requestId: string) {
  assertAllowlisted(userId);
  if (!Types.ObjectId.isValid(currentSessionId)) throw new AppError(401, "INVALID_SESSION", "The session is invalid or expired");
  if (Buffer.byteLength(password, "utf8") > 72) throw new AppError(400, "VALIDATION_FAILED", "Password confirmation is invalid");
  const user = await User.findOne({ _id: userId, status: "ACTIVE" }).select("+passwordHash email emailVerifiedAt");
  const passwordMatches = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !passwordMatches) throw new AppError(401, "INVALID_CREDENTIALS", "Password confirmation failed");
  if (!user.emailVerifiedAt) throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify the administrator account before replacing MFA");

  const secret = generateTotpSecret();
  const encryptedSecret = encryptMfaSecret(secret);
  const pendingMfaExpiresAt = new Date(Date.now() + 10 * 60_000);
  await withTransaction(async (session: ClientSession) => {
    const now = new Date();
    const elevatedSession = await Session.exists({ _id: currentSessionId, userId, revokedAt: null, accessExpiresAt: { $gt: now }, refreshExpiresAt: { $gt: now }, platformMfaVerifiedUntil: { $gt: now } }).session(session);
    if (!elevatedSession) throw new AppError(403, "PLATFORM_MFA_STEP_UP_REQUIRED", "Verify MFA before replacing the authenticator");
    const admin = await PlatformAdmin.findOne({ userId, status: "ACTIVE", mfaEnabledAt: { $ne: null } }).session(session);
    if (!admin) throw new AppError(409, "PLATFORM_MFA_NOT_ENABLED", "Enable platform MFA before replacing it");
    admin.pendingMfaSecretEncrypted = encryptedSecret;
    admin.pendingMfaExpiresAt = pendingMfaExpiresAt;
    admin.pendingMfaPurpose = "REPLACEMENT";
    admin.pendingMfaSessionId = new Types.ObjectId(currentSessionId);
    admin.aggregateVersion += 1;
    await admin.save({ session });
    await recordAudit({ actorType: "USER", actorId: userId, action: "platform_admin.mfa.replacement_started", outcome: "SUCCEEDED", resourceType: "platform_admin", resourceId: userId, requestId, metadata: { expiresAt: pendingMfaExpiresAt } }, session);
  });

  return { secret, otpauthUri: createTotpUri(user.email, secret), expiresAt: pendingMfaExpiresAt };
}

export async function confirmPlatformMfaReplacement(userId: string, currentSessionId: string, code: string, requestId: string) {
  assertAllowlisted(userId);
  if (!Types.ObjectId.isValid(currentSessionId)) throw new AppError(401, "INVALID_SESSION", "The session is invalid or expired");
  return withTransaction(async (session: ClientSession) => {
    const now = new Date();
    const admin = await PlatformAdmin.findOne({ userId, status: "ACTIVE", mfaEnabledAt: { $ne: null }, pendingMfaPurpose: "REPLACEMENT", pendingMfaSessionId: currentSessionId, pendingMfaExpiresAt: { $gt: now } })
      .select("+pendingMfaSecretEncrypted +pendingMfaPurpose +pendingMfaSessionId +lastAcceptedTotpStep +recoveryCodeHashes")
      .session(session);
    if (!admin?.pendingMfaSecretEncrypted) throw new AppError(409, "PLATFORM_MFA_REPLACEMENT_EXPIRED", "Start a new MFA replacement before confirming");

    const acceptedStep = verifyTotpCode(decryptMfaSecret(admin.pendingMfaSecretEncrypted), code, now.getTime());
    if (acceptedStep === null) throw new AppError(401, "PLATFORM_MFA_CODE_INVALID", "The new authenticator code is invalid or expired");

    const recoveryCodes = generateRecoveryCodes();
    admin.mfaSecretEncrypted = admin.pendingMfaSecretEncrypted;
    admin.pendingMfaSecretEncrypted = null;
    admin.pendingMfaExpiresAt = null;
    admin.pendingMfaPurpose = null;
    admin.pendingMfaSessionId = null;
    admin.lastAcceptedTotpStep = Math.max(admin.lastAcceptedTotpStep, acceptedStep);
    admin.recoveryCodeHashes = recoveryCodes.map((recoveryCode) => {
      const hash = hashRecoveryCode(recoveryCode);
      if (!hash) throw new Error("Generated platform recovery code is invalid");
      return hash;
    });
    admin.aggregateVersion += 1;
    await admin.save({ session });

    const revoked = await Session.updateMany(
      { userId, _id: { $ne: currentSessionId }, revokedAt: null },
      { $set: { revokedAt: now, platformMfaVerifiedUntil: null } },
      { session },
    );
    const currentSession = await Session.updateOne(
      { _id: currentSessionId, userId, revokedAt: null, accessExpiresAt: { $gt: now }, refreshExpiresAt: { $gt: now } },
      { $set: { platformMfaVerifiedUntil: null } },
      { session },
    );
    if (currentSession.matchedCount !== 1) throw new AppError(401, "INVALID_SESSION", "The session is invalid or expired");

    await recordAudit({ actorType: "USER", actorId: userId, action: "platform_admin.mfa.replaced", outcome: "SUCCEEDED", resourceType: "platform_admin", resourceId: userId, requestId, metadata: { recoveryCodeCount: recoveryCodes.length, revokedSessionCount: revoked.modifiedCount } }, session);
    return { replacedAt: now, recoveryCodes, revokedSessionCount: revoked.modifiedCount };
  });
}

export async function verifyPlatformAdminStepUp(userId: string, sessionId: string, code: string, requestId: string) {
  assertAllowlisted(userId);
  if (!Types.ObjectId.isValid(sessionId)) throw new AppError(401, "INVALID_SESSION", "The session is invalid or expired");
  return withTransaction(async (session: ClientSession) => {
    const admin = await PlatformAdmin.findOne({ userId, status: "ACTIVE", mfaEnabledAt: { $ne: null } })
      .select("+mfaSecretEncrypted +lastAcceptedTotpStep +recoveryCodeHashes")
      .session(session);
    if (!admin?.mfaSecretEncrypted) throw new AppError(403, "PLATFORM_MFA_REQUIRED", "Complete platform administrator MFA enrollment first");

    const now = new Date();
    const totpStep = verifyTotpCode(decryptMfaSecret(admin.mfaSecretEncrypted), code, now.getTime());
    let verificationMethod: "TOTP" | "RECOVERY_CODE";
    if (totpStep !== null) {
      const consumed = await PlatformAdmin.updateOne({ _id: admin._id, lastAcceptedTotpStep: { $lt: totpStep } }, { $set: { lastAcceptedTotpStep: totpStep }, $inc: { aggregateVersion: 1 } }, { session });
      if (consumed.modifiedCount !== 1) throw new AppError(401, "PLATFORM_MFA_CODE_INVALID", "The authenticator code is invalid, expired, or already used");
      verificationMethod = "TOTP";
    } else {
      const recoveryCodeHash = hashRecoveryCode(code);
      if (!recoveryCodeHash) throw new AppError(401, "PLATFORM_MFA_CODE_INVALID", "The authenticator code is invalid or expired");
      const consumed = await PlatformAdmin.updateOne({ _id: admin._id, recoveryCodeHashes: recoveryCodeHash }, { $pull: { recoveryCodeHashes: recoveryCodeHash }, $inc: { aggregateVersion: 1 } }, { session });
      if (consumed.modifiedCount !== 1) throw new AppError(401, "PLATFORM_MFA_CODE_INVALID", "The authenticator code is invalid, expired, or already used");
      verificationMethod = "RECOVERY_CODE";
    }

    const verifiedUntil = new Date(now.getTime() + stepUpDurationMs);
    const sessionUpdate = await Session.updateOne({ _id: sessionId, userId, revokedAt: null, accessExpiresAt: { $gt: now }, refreshExpiresAt: { $gt: now } }, { $set: { platformMfaVerifiedUntil: verifiedUntil } }, { session });
    if (sessionUpdate.modifiedCount !== 1) throw new AppError(401, "INVALID_SESSION", "The session is invalid or expired");
    await recordAudit({ actorType: "USER", actorId: userId, action: verificationMethod === "TOTP" ? "platform_admin.mfa.step_up" : "platform_admin.mfa.recovery_code_used", outcome: "SUCCEEDED", resourceType: "platform_admin", resourceId: userId, requestId, metadata: { method: verificationMethod, verifiedUntil } }, session);
    return { verifiedUntil, method: verificationMethod };
  });
}
