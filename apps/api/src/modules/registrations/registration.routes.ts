import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { Types } from "mongoose";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { applyRegistrationSchema, registrationDecisionSchema } from "./registration.schemas.js";
import { applyToTournament, decideRegistration, getMyRegistration, listTournamentRegistrations } from "./registration.service.js";

export const registrationRouter = Router();
registrationRouter.use(requireIdentity, requireVerifiedIdentity);
const applicationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many application attempts. Try again later.", requestId: res.locals.requestId } }),
});
const listLimit = (value: unknown) => {
  const limit = Number(value ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "VALIDATION_FAILED", "limit must be an integer from 1 to 100");
  return limit;
};
function requireId(value: string, code: string): void {
  if (!Types.ObjectId.isValid(value) || !/^[a-f\d]{24}$/i.test(value)) throw new AppError(404, code, "Resource was not found");
}

registrationRouter.post("/:tenantId/tournaments/:tournamentId/registrations", applicationLimiter, asyncHandler(async (req, res) => {
  const parsed = applyRegistrationSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "CONSENT_REQUIRED", "Confirm that you consent to share your profile for tournament participation");
  requireId(req.params.tenantId, "TENANT_NOT_FOUND");
  requireId(req.params.tournamentId, "TOURNAMENT_NOT_FOUND");
  const principal = res.locals.principal as { id: string };
  const registration = await applyToTournament(req.params.tenantId, req.params.tournamentId, principal.id, String(res.locals.requestId));
  res.status(201).json({ data: { registration }, meta: { requestId: res.locals.requestId } });
}));

registrationRouter.get("/:tenantId/tournaments/:tournamentId/registrations/me", asyncHandler(async (req, res) => {
  requireId(req.params.tenantId, "TENANT_NOT_FOUND");
  requireId(req.params.tournamentId, "TOURNAMENT_NOT_FOUND");
  const principal = res.locals.principal as { id: string };
  const registration = await getMyRegistration(req.params.tenantId, req.params.tournamentId, principal.id);
  res.json({ data: { registration }, meta: { requestId: res.locals.requestId } });
}));

registrationRouter.get("/:tenantId/tournaments/:tournamentId/registrations", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  requireId(req.params.tournamentId, "TOURNAMENT_NOT_FOUND");
  const limit = listLimit(req.query.limit);
  const registrations = await listTournamentRegistrations(req.params.tenantId, req.params.tournamentId, limit);
  res.json({ data: { registrations }, meta: { requestId: res.locals.requestId, limit } });
}));

registrationRouter.post("/:tenantId/tournaments/:tournamentId/registrations/:registrationId/decision", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  requireId(req.params.tournamentId, "TOURNAMENT_NOT_FOUND");
  const parsed = registrationDecisionSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Application decision is invalid", { issues: parsed.error.issues.map((e) => ({ path: e.path.join("."), code: e.code })) });
  const principal = res.locals.principal as { id: string };
  const registration = await decideRegistration(req.params.tenantId, req.params.tournamentId, req.params.registrationId, principal.id, String(res.locals.requestId), parsed.data);
  res.json({ data: { registration }, meta: { requestId: res.locals.requestId } });
}));
