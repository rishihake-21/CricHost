import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { createPlayerProfileSchema, updatePlayerProfileSchema } from "./player.schemas.js";
import { createPlayerProfile, getMyPlayerProfile, updateMyPlayerProfile } from "./player.service.js";

export const playerRouter = Router();
const profileCreationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many profile creation attempts. Try again later.", requestId: res.locals.requestId } }),
});
playerRouter.use(requireIdentity, requireVerifiedIdentity);

playerRouter.post("/", profileCreationLimiter, asyncHandler(async (req, res) => {
  const parsed = createPlayerProfileSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Player profile details are invalid", { issues: parsed.error.issues.map((e) => ({ path: e.path.join("."), code: e.code })) });
  const principal = res.locals.principal as { id: string };
  const profile = await createPlayerProfile(principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: { profile }, meta: { requestId: res.locals.requestId } });
}));

playerRouter.get("/me", asyncHandler(async (_req, res) => {
  const principal = res.locals.principal as { id: string };
  const profile = await getMyPlayerProfile(principal.id);
  res.json({ data: { profile }, meta: { requestId: res.locals.requestId } });
}));

playerRouter.patch("/me", asyncHandler(async (req, res) => {
  const parsed = updatePlayerProfileSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Profile update is invalid", { issues: parsed.error.issues.map((e) => ({ path: e.path.join("."), code: e.code })) });
  const principal = res.locals.principal as { id: string };
  const profile = await updateMyPlayerProfile(principal.id, String(res.locals.requestId), parsed.data);
  res.json({ data: { profile }, meta: { requestId: res.locals.requestId } });
}));
