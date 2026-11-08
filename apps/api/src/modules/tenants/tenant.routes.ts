import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { acceptInvitationSchema, createInvitationSchema, removeMemberSchema, revokeInvitationSchema, updateMemberRoleSchema } from "../memberships/membership.schemas.js";
import { acceptTenantInvitation, createTenantInvitation, listTenantInvitations, removeTenantMember, revokeTenantInvitation, updateTenantMemberRole } from "../memberships/membership.service.js";
import { createTenantSchema } from "./tenant.schemas.js";
import { createTenant, getTenant, listMyTenants, listTenantMembers } from "./tenant.service.js";

export const tenantRouter = Router();
const tenantCreationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many organization creation attempts. Try again later.", requestId: res.locals.requestId } }),
});
const invitationLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many invitation attempts. Try again later.", requestId: res.locals.requestId } }),
});
tenantRouter.use(requireIdentity, requireVerifiedIdentity);

tenantRouter.post("/", tenantCreationLimiter, asyncHandler(async (_req, res) => {
  const parsed = createTenantSchema.safeParse(_req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Organization details are invalid", { issues: parsed.error.issues.map((e) => ({ path: e.path.join("."), code: e.code })) });
  const principal = res.locals.principal as { id: string };
  const result = await createTenant(parsed.data, principal.id, String(res.locals.requestId));
  res.status(201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));

tenantRouter.get("/", asyncHandler(async (_req, res) => {
  const principal = res.locals.principal as { id: string };
  const tenants = await listMyTenants(principal.id);
  res.json({ data: { tenants }, meta: { requestId: res.locals.requestId } });
}));

tenantRouter.get("/:tenantId/members", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const members = await listTenantMembers(req.params.tenantId);
  res.json({ data: { members }, meta: { requestId: res.locals.requestId } });
}));

tenantRouter.get("/:tenantId/invitations", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const invitations = await listTenantInvitations(req.params.tenantId);
  res.json({ data: { invitations }, meta: { requestId: res.locals.requestId } });
}));

tenantRouter.post("/:tenantId/invitations", invitationLimiter, requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = createInvitationSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Invitation details are invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const result = await createTenantInvitation(req.params.tenantId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));

tenantRouter.post("/:tenantId/invitations/:invitationId/accept", invitationLimiter, asyncHandler(async (req, res) => {
  const parsed = acceptInvitationSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Invitation token is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const membership = await acceptTenantInvitation(req.params.tenantId, req.params.invitationId, principal.id, parsed.data.token, String(res.locals.requestId));
  res.json({ data: { membership }, meta: { requestId: res.locals.requestId } });
}));

tenantRouter.post("/:tenantId/invitations/:invitationId/revoke", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = revokeInvitationSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Provide a reason to revoke the invitation", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const invitation = await revokeTenantInvitation(req.params.tenantId, req.params.invitationId, principal.id, String(res.locals.requestId), parsed.data.reason);
  res.json({ data: { invitation }, meta: { requestId: res.locals.requestId } });
}));

tenantRouter.patch("/:tenantId/members/:userId/role", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = updateMemberRoleSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Membership role is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const membership = await updateTenantMemberRole(req.params.tenantId, req.params.userId, principal.id, String(res.locals.requestId), parsed.data.role);
  res.json({ data: { membership }, meta: { requestId: res.locals.requestId } });
}));

tenantRouter.post("/:tenantId/members/:userId/remove", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = removeMemberSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Provide a reason to remove the organization member", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const membership = await removeTenantMember(req.params.tenantId, req.params.userId, principal.id, String(res.locals.requestId), parsed.data.reason);
  res.json({ data: { membership }, meta: { requestId: res.locals.requestId } });
}));

tenantRouter.get("/:tenantId", requireTenantMembership(), asyncHandler(async (req, res) => {
  const tenant = await getTenant(req.params.tenantId);
  res.json({ data: { tenant }, meta: { requestId: res.locals.requestId } });
}));
