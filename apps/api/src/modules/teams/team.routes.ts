import { Router } from "express";
import { Types } from "mongoose";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { assignTeamStaffSchema, addRosterEntrySchema, createTeamSchema, releaseRosterEntrySchema } from "./team.schemas.js";
import { assignTeamStaff, addRosterEntry, createTeam, getTeam, listTeamRoster, listTeamStaff, listTeams, releaseRosterEntry } from "./team.service.js";
import { requireTeamRoles } from "./team-authorization.js";

export const teamRouter = Router();
teamRouter.use(requireIdentity, requireVerifiedIdentity);

function requireId(value: string, code: string): void {
  if (!Types.ObjectId.isValid(value) || !/^[a-f\d]{24}$/i.test(value)) throw new AppError(404, code, "Resource was not found");
}

teamRouter.post("/:tenantId/tournaments/:tournamentId/teams", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  requireId(req.params.tournamentId, "TOURNAMENT_NOT_FOUND");
  const parsed = createTeamSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Team details are invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const team = await createTeam(req.params.tenantId, req.params.tournamentId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: { team }, meta: { requestId: res.locals.requestId } });
}));

teamRouter.get("/:tenantId/tournaments/:tournamentId/teams", requireTenantMembership(), asyncHandler(async (req, res) => {
  requireId(req.params.tournamentId, "TOURNAMENT_NOT_FOUND");
  const teams = await listTeams(req.params.tenantId, req.params.tournamentId);
  res.json({ data: { teams }, meta: { requestId: res.locals.requestId } });
}));

teamRouter.get("/:tenantId/tournaments/:tournamentId/teams/:teamId", requireTenantMembership(), asyncHandler(async (req, res) => {
  requireId(req.params.tournamentId, "TOURNAMENT_NOT_FOUND");
  const team = await getTeam(req.params.tenantId, req.params.tournamentId, req.params.teamId);
  res.json({ data: { team }, meta: { requestId: res.locals.requestId } });
}));

teamRouter.get("/:tenantId/tournaments/:tournamentId/teams/:teamId/staff", requireTenantMembership(), asyncHandler(async (req, res) => {
  requireId(req.params.tournamentId, "TOURNAMENT_NOT_FOUND");
  await getTeam(req.params.tenantId, req.params.tournamentId, req.params.teamId);
  const staff = await listTeamStaff(req.params.tenantId, req.params.tournamentId, req.params.teamId);
  res.json({ data: { staff }, meta: { requestId: res.locals.requestId } });
}));

teamRouter.post("/:tenantId/tournaments/:tournamentId/teams/:teamId/staff", requireTenantMembership(), requireTeamRoles(["OWNER"]), asyncHandler(async (req, res) => {
  const parsed = assignTeamStaffSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Team staff assignment is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const staff = await assignTeamStaff(req.params.tenantId, req.params.tournamentId, req.params.teamId, principal.id, String(res.locals.requestId), parsed.data.userId, parsed.data.role);
  res.status(201).json({ data: { staff }, meta: { requestId: res.locals.requestId } });
}));

teamRouter.get("/:tenantId/tournaments/:tournamentId/teams/:teamId/roster", requireTenantMembership(), asyncHandler(async (req, res) => {
  requireId(req.params.tournamentId, "TOURNAMENT_NOT_FOUND");
  await getTeam(req.params.tenantId, req.params.tournamentId, req.params.teamId);
  if (req.query.includeReleased !== undefined && !["true", "false"].includes(String(req.query.includeReleased))) throw new AppError(400, "VALIDATION_FAILED", "includeReleased must be true or false");
  const roster = await listTeamRoster(req.params.tenantId, req.params.tournamentId, req.params.teamId, req.query.includeReleased === "true");
  res.json({ data: { roster }, meta: { requestId: res.locals.requestId } });
}));

teamRouter.post("/:tenantId/tournaments/:tournamentId/teams/:teamId/roster", requireTenantMembership(), requireTeamRoles(["OWNER", "MANAGER"]), asyncHandler(async (req, res) => {
  const parsed = addRosterEntrySchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Roster assignment is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const rosterEntry = await addRosterEntry(req.params.tenantId, req.params.tournamentId, req.params.teamId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: { rosterEntry }, meta: { requestId: res.locals.requestId } });
}));

teamRouter.post("/:tenantId/tournaments/:tournamentId/teams/:teamId/roster/:playerProfileId/release", requireTenantMembership(), requireTeamRoles(["OWNER", "MANAGER"]), asyncHandler(async (req, res) => {
  const parsed = releaseRosterEntrySchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Roster release requires the current version and a reason", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const rosterEntry = await releaseRosterEntry(req.params.tenantId, req.params.tournamentId, req.params.teamId, req.params.playerProfileId, principal.id, String(res.locals.requestId), parsed.data);
  res.json({ data: { rosterEntry }, meta: { requestId: res.locals.requestId } });
}));
