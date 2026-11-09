import { Router } from "express";
import { AppError } from "../../platform/errors/app-error.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { getTenantSubscription } from "./subscription.service.js";

export const subscriptionRouter = Router();
subscriptionRouter.use(requireIdentity, requireVerifiedIdentity);

subscriptionRouter.get("/:tenantId/subscription", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const subscription = await getTenantSubscription(req.params.tenantId);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { subscription }, meta: { requestId: res.locals.requestId } });
}));

subscriptionRouter.all("/:tenantId/subscription/*", (_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Resource was not found")));
