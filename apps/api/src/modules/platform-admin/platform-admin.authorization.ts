import type { RequestHandler, Response } from "express";
import { Types } from "mongoose";
import { env } from "../../platform/config/env.js";
import { AppError } from "../../platform/errors/app-error.js";
import { Session } from "../identity/models/session.model.js";
import { PlatformAdmin } from "./models/platform-admin.model.js";

function principalFrom(response: Response): { id: string; emailVerified?: boolean } | undefined {
  return response.locals.principal as { id: string; emailVerified?: boolean } | undefined;
}

export const requireAllowlistedPlatformIdentity: RequestHandler = (_req, res, next) => {
  const principal = principalFrom(res);
  if (!principal?.id) return next(new AppError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue"));
  if (!principal.emailVerified) return next(new AppError(403, "EMAIL_NOT_VERIFIED", "Verify the administrator account before continuing"));
  if (!env.platformAdminUserIds.includes(principal.id.toLowerCase())) return next(new AppError(403, "PLATFORM_ADMIN_REQUIRED", "Platform administrator access is required"));
  next();
};

export const requirePlatformAdminStepUp: RequestHandler = (_req, res, next) => {
  const principal = principalFrom(res);
  const sessionId = res.locals.authSessionId as string | undefined;
  if (!principal?.id || !sessionId || !Types.ObjectId.isValid(sessionId)) return next(new AppError(401, "INVALID_SESSION", "The session is invalid or expired"));
  if (!env.platformAdminUserIds.includes(principal.id.toLowerCase())) return next(new AppError(403, "PLATFORM_ADMIN_REQUIRED", "Platform administrator access is required"));

  const now = new Date();
  void Promise.all([
    PlatformAdmin.exists({ userId: principal.id, status: "ACTIVE", mfaEnabledAt: { $ne: null } }),
    Session.exists({ _id: sessionId, userId: principal.id, revokedAt: null, accessExpiresAt: { $gt: now }, refreshExpiresAt: { $gt: now }, platformMfaVerifiedUntil: { $gt: now } }),
  ]).then(([admin, elevatedSession]) => {
    if (!admin) return next(new AppError(403, "PLATFORM_MFA_REQUIRED", "Complete platform administrator MFA enrollment first"));
    if (!elevatedSession) return next(new AppError(403, "PLATFORM_MFA_STEP_UP_REQUIRED", "Verify MFA before using platform administrator functions"));
    next();
  }).catch(next);
};
