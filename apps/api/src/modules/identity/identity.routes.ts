import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { env } from "../../platform/config/env.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { login, logout, refresh, register, verifyEmail } from "./identity.service.js";
import { loginSchema, registerSchema, verifyEmailSchema } from "./identity.schemas.js";
import { requireIdentity } from "./identity.middleware.js";

export const identityRouter = Router();
const limiterOptions = (windowMs: number, max: number) => ({
  windowMs, max, standardHeaders: true as const, legacyHeaders: false as const,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later.", requestId: res.locals.requestId } }),
});
const authLimiter = rateLimit(limiterOptions(15 * 60_000, 20));
const verifyLimiter = rateLimit(limiterOptions(60 * 60_000, 10));
const cookieBase = { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
const userAgent = (req: Request): string | undefined => req.header("user-agent")?.slice(0, 300);
function getCookie(req: Request, name: string): string | undefined {
  const prefix = `${name}=`;
  const entry = req.header("cookie")?.split(";").map((x) => x.trim()).find((x) => x.startsWith(prefix));
  if (!entry) return undefined;
  try { return decodeURIComponent(entry.slice(prefix.length)); } catch { return undefined; }
}
function setCredentials(res: Response, tokens: { accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date }) {
  res.cookie("ch_access", tokens.accessToken, { ...cookieBase, maxAge: Math.max(0, tokens.accessExpiresAt.getTime() - Date.now()) });
  res.cookie("ch_refresh", tokens.refreshToken, { ...cookieBase, path: "/v1/auth", maxAge: Math.max(0, tokens.refreshExpiresAt.getTime() - Date.now()) });
}
function clearCredentials(res: Response) {
  res.clearCookie("ch_access", cookieBase);
  res.clearCookie("ch_refresh", { ...cookieBase, path: "/v1/auth" });
}

identityRouter.post("/register", authLimiter, asyncHandler(async (req, res) => {
  const input = registerSchema.safeParse(req.body);
  if (!input.success) throw new AppError(400, "VALIDATION_FAILED", "Registration details are invalid", { issues: input.error.issues.map((e) => ({ path: e.path.join("."), code: e.code })) });
  const result = await register(input.data);
  res.status(201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));

identityRouter.post("/verify-email", verifyLimiter, asyncHandler(async (req, res) => {
  const input = verifyEmailSchema.safeParse(req.body);
  if (!input.success) throw new AppError(400, "VALIDATION_FAILED", "Verification token is invalid");
  const user = await verifyEmail(input.data.token);
  res.json({ data: { user }, meta: { requestId: res.locals.requestId } });
}));

identityRouter.post("/login", authLimiter, asyncHandler(async (req, res) => {
  const input = loginSchema.safeParse(req.body);
  if (!input.success) throw new AppError(400, "VALIDATION_FAILED", "Email or password is invalid");
  const result = await login(input.data, userAgent(req));
  setCredentials(res, result.credentials);
  res.json({ data: { user: result.user, accessExpiresAt: result.credentials.accessExpiresAt }, meta: { requestId: res.locals.requestId } });
}));

identityRouter.post("/refresh", authLimiter, asyncHandler(async (req, res) => {
  const token = getCookie(req, "ch_refresh");
  if (!token) throw new AppError(401, "INVALID_SESSION", "The session is invalid or expired");
  const credentials = await refresh(token, userAgent(req));
  setCredentials(res, credentials);
  res.json({ data: { accessExpiresAt: credentials.accessExpiresAt }, meta: { requestId: res.locals.requestId } });
}));

identityRouter.post("/logout", asyncHandler(async (req, res) => {
  await logout(getCookie(req, "ch_refresh"), getCookie(req, "ch_access"));
  clearCredentials(res);
  res.status(204).end();
}));

identityRouter.get("/me", requireIdentity, asyncHandler(async (_req, res) => {
  res.json({ data: { user: res.locals.principal }, meta: { requestId: res.locals.requestId } });
}));
