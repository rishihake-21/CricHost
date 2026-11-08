import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { getTournament } from "../tournaments/tournament.service.js";
import { generateFixturesSchema } from "./fixture.schemas.js";
import { generateFixtures, getStandings, listFixtures } from "./fixture.service.js";

export const fixtureRouter = Router();
fixtureRouter.use(requireIdentity, requireVerifiedIdentity);

fixtureRouter.post("/:tenantId/tournaments/:tournamentId/fixtures/generate", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = generateFixturesSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Fixture generation inputs are invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const result = await generateFixtures(req.params.tenantId, req.params.tournamentId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));

fixtureRouter.get("/:tenantId/tournaments/:tournamentId/fixtures", requireTenantMembership(), asyncHandler(async (req, res) => {
  await getTournament(req.params.tenantId, req.params.tournamentId);
  const fixtures = await listFixtures(req.params.tenantId, req.params.tournamentId);
  res.json({ data: { fixtures }, meta: { requestId: res.locals.requestId, count: fixtures.length } });
}));

fixtureRouter.get("/:tenantId/tournaments/:tournamentId/standings", requireTenantMembership(), asyncHandler(async (req, res) => {
  await getTournament(req.params.tenantId, req.params.tournamentId);
  const standings = await getStandings(req.params.tenantId, req.params.tournamentId);
  res.json({ data: { standings }, meta: { requestId: res.locals.requestId, count: standings.length } });
}));
