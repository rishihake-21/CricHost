import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { AppError } from "../errors/app-error.js";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const originGuard: RequestHandler = (req, _res, next) => {
  if (!unsafeMethods.has(req.method)) return next();
  const origin = req.header("origin");
  if (origin && !env.webOrigins.includes(origin)) return next(new AppError(403, "ORIGIN_NOT_ALLOWED", "Request origin is not allowed"));
  const usesCookieSession = /(?:^|;)\s*ch_(?:access|refresh)=/.test(req.header("cookie") ?? "");
  if (usesCookieSession && !origin) return next(new AppError(403, "ORIGIN_REQUIRED", "Origin header is required for cookie-authenticated changes"));
  if (req.header("sec-fetch-site") === "cross-site") return next(new AppError(403, "ORIGIN_NOT_ALLOWED", "Cross-site changes are not allowed"));
  next();
};
