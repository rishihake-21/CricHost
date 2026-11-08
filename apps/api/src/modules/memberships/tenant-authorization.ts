import type { RequestHandler } from "express";
import { Types } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { Membership } from "../memberships/models/membership.model.js";

type TenantRole = "OWNER" | "ADMIN" | "MEMBER";

export const requireVerifiedIdentity: RequestHandler = (_req, res, next) => {
  const principal = res.locals.principal as { emailVerified?: boolean } | undefined;
  if (!principal) return next(new AppError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue"));
  if (!principal.emailVerified) return next(new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email before managing an organization"));
  next();
};

export function requireTenantMembership(roles?: TenantRole[]): RequestHandler {
  return (req, res, next) => {
    const tenantId = req.params.tenantId;
    const principal = res.locals.principal as { id?: string } | undefined;
    if (!principal?.id) return next(new AppError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue"));
    if (!tenantId || !/^[a-f\d]{24}$/i.test(tenantId) || !Types.ObjectId.isValid(tenantId)) {
      return next(new AppError(404, "TENANT_NOT_FOUND", "Organization was not found"));
    }
    void Membership.findOne({ tenantId, userId: principal.id, status: "ACTIVE" })
      .then((membership) => {
        if (!membership) return next(new AppError(404, "TENANT_NOT_FOUND", "Organization was not found"));
        if (roles && !roles.includes(membership.role as TenantRole)) return next(new AppError(403, "PERMISSION_DENIED", "You do not have permission to perform this action"));
        res.locals.tenantMembership = { tenantId, role: membership.role, userId: principal.id };
        next();
      })
      .catch(next);
  };
}
