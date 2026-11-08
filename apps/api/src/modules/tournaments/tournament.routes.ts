import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { createTournamentSchema, transitionTournamentSchema, updateTournamentRulesSchema } from "./tournament.schemas.js";
import { createTournament, getTournament, listTournaments, transitionTournament, updateTournamentRules } from "./tournament.service.js";
import { Types } from "mongoose";

export const tournamentRouter = Router();
tournamentRouter.use(requireIdentity, requireVerifiedIdentity);
const listQuerySchema = (value: unknown) => {
  const result = Number(value ?? 50);
  if (!Number.isInteger(result) || result < 1 || result > 100) throw new AppError(400, "VALIDATION_FAILED", "limit must be an integer from 1 to 100");
  return result;
};
const routeId = (id: string) => {
  if (!Types.ObjectId.isValid(id) || !/^[a-f\d]{24}$/i.test(id)) throw new AppError(404, "TOURNAMENT_NOT_FOUND", "Tournament was not found");
};

tournamentRouter.post("/:tenantId/tournaments", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = createTournamentSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Tournament details are invalid", { issues: parsed.error.issues.map((e) => ({ path: e.path.join("."), code: e.code })) });
  const principal = res.locals.principal as { id: string };
  const result = await createTournament(req.params.tenantId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: { tournament: result }, meta: { requestId: res.locals.requestId } });
}));

tournamentRouter.get("/:tenantId/tournaments", requireTenantMembership(), asyncHandler(async (req, res) => {
  const limit = listQuerySchema(req.query.limit);
  const tournaments = await listTournaments(req.params.tenantId, limit);
  res.json({ data: { tournaments }, meta: { requestId: res.locals.requestId, limit } });
}));

tournamentRouter.get("/:tenantId/tournaments/:tournamentId", requireTenantMembership(), asyncHandler(async (req, res) => {
  routeId(req.params.tournamentId);
  const tournament = await getTournament(req.params.tenantId, req.params.tournamentId);
  res.json({ data: { tournament }, meta: { requestId: res.locals.requestId } });
}));

tournamentRouter.patch("/:tenantId/tournaments/:tournamentId/rules", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = updateTournamentRulesSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Rules update is invalid", { issues: parsed.error.issues.map((e) => ({ path: e.path.join("."), code: e.code })) });
  const principal = res.locals.principal as { id: string };
  const tournament = await updateTournamentRules(req.params.tenantId, req.params.tournamentId, principal.id, String(res.locals.requestId), parsed.data.expectedVersion, parsed.data.rules);
  res.json({ data: { tournament }, meta: { requestId: res.locals.requestId } });
}));

tournamentRouter.post("/:tenantId/tournaments/:tournamentId/transitions", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = transitionTournamentSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Tournament transition is invalid");
  const principal = res.locals.principal as { id: string };
  const tournament = await transitionTournament(req.params.tenantId, req.params.tournamentId, principal.id, String(res.locals.requestId), parsed.data.targetStatus, parsed.data.reason);
  res.json({ data: { tournament }, meta: { requestId: res.locals.requestId } });
}));
