import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { getTenantUsage } from "./usage.service.js";

export const usageRouter = Router();
usageRouter.use(requireIdentity, requireVerifiedIdentity);

usageRouter.get("/:tenantId/usage", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const usage = await getTenantUsage(req.params.tenantId);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { usage }, meta: { requestId: res.locals.requestId } });
}));
