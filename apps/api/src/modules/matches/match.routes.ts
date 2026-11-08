import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { acquireScorerLease, appendDelivery, correctDelivery, listDeliveryEvents } from "../scoring/scoring.service.js";
import {
  acquireScorerLeaseSchema, appendDeliverySchema, assignMatchScorerSchema, closeInningsSchema, correctDeliverySchema,
  completeMatchSchema, createMatchSchema, listDeliveriesQuerySchema, startMatchSchema, startNextInningsSchema,
} from "./match.schemas.js";
import {
  assignMatchScorer, closeInnings, completeMatch, createMatch, getMatchSnapshot, listTournamentMatches, removeMatchScorer,
  startMatch, startNextInnings,
} from "./match.service.js";

export const matchRouter = Router();
matchRouter.use(requireIdentity, requireVerifiedIdentity);

function body<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Match or scoring inputs are invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  return parsed.data;
}

const principal = (res: { locals: Record<string, unknown> }) => res.locals.principal as { id: string };
const requestId = (res: { locals: Record<string, unknown> }) => String(res.locals.requestId);
const scoringLimiter = rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false });
const leaseLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
const correctionLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

matchRouter.post("/:tenantId/tournaments/:tournamentId/fixtures/:fixtureId/match", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const input = body(createMatchSchema, req.body);
  const result = await createMatch(req.params.tenantId, req.params.tournamentId, req.params.fixtureId, principal(res).id, requestId(res), input.expectedFixtureVersion);
  res.status(201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));

matchRouter.get("/:tenantId/tournaments/:tournamentId/matches", requireTenantMembership(), asyncHandler(async (req, res) => {
  const matches = await listTournamentMatches(req.params.tenantId, req.params.tournamentId);
  res.json({ data: { matches }, meta: { requestId: res.locals.requestId, count: matches.length } });
}));

matchRouter.get("/:tenantId/tournaments/:tournamentId/matches/:matchId", requireTenantMembership(), asyncHandler(async (req, res) => {
  const result = await getMatchSnapshot(req.params.tenantId, req.params.tournamentId, req.params.matchId);
  res.json({ data: result, meta: { requestId: res.locals.requestId } });
}));

matchRouter.post("/:tenantId/tournaments/:tournamentId/matches/:matchId/start", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const result = await startMatch(req.params.tenantId, req.params.tournamentId, req.params.matchId, principal(res).id, requestId(res), body(startMatchSchema, req.body));
  res.json({ data: result, meta: { requestId: res.locals.requestId } });
}));

matchRouter.post("/:tenantId/tournaments/:tournamentId/matches/:matchId/complete", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const result = await completeMatch(req.params.tenantId, req.params.tournamentId, req.params.matchId, principal(res).id, requestId(res), body(completeMatchSchema, req.body));
  res.json({ data: { match: result }, meta: { requestId: res.locals.requestId } });
}));

matchRouter.post("/:tenantId/tournaments/:tournamentId/matches/:matchId/scorers", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const input = body(assignMatchScorerSchema, req.body);
  const result = await assignMatchScorer(req.params.tenantId, req.params.tournamentId, req.params.matchId, input.userId, principal(res).id, requestId(res));
  res.status(result.replayed ? 200 : 201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));

matchRouter.delete("/:tenantId/tournaments/:tournamentId/matches/:matchId/scorers/:userId", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const result = await removeMatchScorer(req.params.tenantId, req.params.tournamentId, req.params.matchId, req.params.userId, principal(res).id, requestId(res));
  res.json({ data: result, meta: { requestId: res.locals.requestId } });
}));

matchRouter.post("/:tenantId/tournaments/:tournamentId/matches/:matchId/innings/:inningsNumber/lease", leaseLimiter, requireTenantMembership(), asyncHandler(async (req, res) => {
  const inningsNumber = Number(req.params.inningsNumber);
  if (!Number.isInteger(inningsNumber) || inningsNumber < 1 || inningsNumber > 4) throw new AppError(404, "INNINGS_NOT_FOUND", "Innings was not found");
  const result = await acquireScorerLease(req.params.tenantId, req.params.tournamentId, req.params.matchId, inningsNumber, principal(res).id, requestId(res), body(acquireScorerLeaseSchema, req.body));
  res.json({ data: result, meta: { requestId: res.locals.requestId } });
}));

matchRouter.post("/:tenantId/tournaments/:tournamentId/matches/:matchId/innings/:inningsNumber/deliveries", scoringLimiter, requireTenantMembership(), asyncHandler(async (req, res) => {
  const inningsNumber = Number(req.params.inningsNumber);
  if (!Number.isInteger(inningsNumber) || inningsNumber < 1 || inningsNumber > 4) throw new AppError(404, "INNINGS_NOT_FOUND", "Innings was not found");
  const result = await appendDelivery(req.params.tenantId, req.params.tournamentId, req.params.matchId, inningsNumber, principal(res).id, requestId(res), body(appendDeliverySchema, req.body));
  res.status(result.replayed ? 200 : 201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));

matchRouter.post("/:tenantId/tournaments/:tournamentId/matches/:matchId/innings/:inningsNumber/deliveries/corrections", correctionLimiter, requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const inningsNumber = Number(req.params.inningsNumber);
  if (!Number.isInteger(inningsNumber) || inningsNumber < 1 || inningsNumber > 4) throw new AppError(404, "INNINGS_NOT_FOUND", "Innings was not found");
  const result = await correctDelivery(req.params.tenantId, req.params.tournamentId, req.params.matchId, inningsNumber, principal(res).id, requestId(res), body(correctDeliverySchema, req.body));
  res.status(result.replayed ? 200 : 201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));

matchRouter.get("/:tenantId/tournaments/:tournamentId/matches/:matchId/innings/:inningsNumber/deliveries", requireTenantMembership(), asyncHandler(async (req, res) => {
  const inningsNumber = Number(req.params.inningsNumber);
  if (!Number.isInteger(inningsNumber) || inningsNumber < 1 || inningsNumber > 4) throw new AppError(404, "INNINGS_NOT_FOUND", "Innings was not found");
  const query = body(listDeliveriesQuerySchema, req.query);
  const result = await listDeliveryEvents(req.params.tenantId, req.params.tournamentId, req.params.matchId, inningsNumber, query.afterSequence, query.limit);
  res.json({ data: result, meta: { requestId: res.locals.requestId, count: result.events.length } });
}));

matchRouter.post("/:tenantId/tournaments/:tournamentId/matches/:matchId/innings/:inningsNumber/close", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const inningsNumber = Number(req.params.inningsNumber);
  if (!Number.isInteger(inningsNumber) || inningsNumber < 1 || inningsNumber > 4) throw new AppError(404, "INNINGS_NOT_FOUND", "Innings was not found");
  const result = await closeInnings(req.params.tenantId, req.params.tournamentId, req.params.matchId, inningsNumber, principal(res).id, requestId(res), body(closeInningsSchema, req.body));
  res.json({ data: result, meta: { requestId: res.locals.requestId } });
}));

matchRouter.post("/:tenantId/tournaments/:tournamentId/matches/:matchId/innings", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const result = await startNextInnings(req.params.tenantId, req.params.tournamentId, req.params.matchId, principal(res).id, requestId(res), body(startNextInningsSchema, req.body));
  res.status(201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));
