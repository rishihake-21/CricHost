import type { RequestHandler } from "express";
import { AppError } from "../../platform/errors/app-error.js";
import { findUserForAccessToken } from "./identity.service.js";

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

export const requireIdentity: RequestHandler = (req, res, next) => {
  if (res.locals.principal) return next();
  const bearer = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer ?? readCookie(req.header("cookie"), "ch_access");
  if (!token) return next(new AppError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue"));
  void findUserForAccessToken(token).then((auth) => {
    if (!auth) return next(new AppError(401, "INVALID_SESSION", "The session is invalid or expired"));
    res.locals.principal = auth.principal;
    res.locals.authSessionId = auth.sessionId;
    next();
  }).catch(next);
};
