import type { RequestHandler } from "express";
import { Types } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { Membership } from "../memberships/models/membership.model.js";
import { Team } from "../teams/models/team.model.js";
import { TeamStaff } from "../teams/models/team-staff.model.js";

type TeamRole = "OWNER" | "MANAGER";
export function requireTeamRoles(roles: TeamRole[]): RequestHandler {
  return (req, res, next) => {
    const { tenantId, tournamentId, teamId } = req.params;
    const principal = res.locals.principal as { id?: string } | undefined;
    if (!principal?.id) return next(new AppError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue"));
    for (const [value, code] of [[tenantId, "TENANT_NOT_FOUND"], [tournamentId, "TOURNAMENT_NOT_FOUND"], [teamId, "TEAM_NOT_FOUND"]] as const) {
      if (!value || !/^[a-f\d]{24}$/i.test(value) || !Types.ObjectId.isValid(value)) return next(new AppError(404, code, "Resource was not found"));
    }
    void (async () => {
      const team = await Team.findOne({ _id: teamId, tenantId, tournamentId, status: "ACTIVE" });
      if (!team) throw new AppError(404, "TEAM_NOT_FOUND", "Team was not found");
      const membership = await Membership.findOne({ tenantId, userId: principal.id, status: "ACTIVE" });
      if (membership && ["OWNER", "ADMIN"].includes(membership.role)) return;
      const staff = await TeamStaff.findOne({ teamId, userId: principal.id, status: "ACTIVE", roles: { $in: roles } });
      if (!staff) throw new AppError(403, "PERMISSION_DENIED", "Team owner or manager permission is required");
    })().then(() => next()).catch(next);
  };
}
