import type { ClientSession } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { Membership } from "../memberships/models/membership.model.js";
import { Tenant } from "./models/tenant.model.js";
import type { CreateTenantInput } from "./tenant.schemas.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { TenantSubscription } from "../subscriptions/models/tenant-subscription.model.js";

function tenantDto(tenant: { id: string; name: string; slug: string; timezone: string; locale: string; status: string; createdAt: Date }) {
  return { id: tenant.id, name: tenant.name, slug: tenant.slug, timezone: tenant.timezone, locale: tenant.locale, status: tenant.status, createdAt: tenant.createdAt };
}

export async function createTenant(input: CreateTenantInput, userId: string, requestId: string) {
  try {
    return await withTransaction(async (session: ClientSession) => {
      const [tenant] = await Tenant.create([{
        name: input.name,
        slug: input.slug,
        timezone: input.timezone,
        locale: input.locale,
        createdById: userId,
      }], { session });
      if (!tenant) throw new Error("Tenant creation returned no record");
      await Membership.create([{ tenantId: tenant._id, userId, role: "OWNER", status: "ACTIVE", joinedAt: new Date() }], { session });
      await TenantSubscription.create([{ tenantId: tenant._id, status: "UNCONFIGURED", planCode: null, planVersion: null, limitsSnapshot: null, featuresSnapshot: [], billingProvider: "NONE", aggregateVersion: 1 }], { session });
      await recordAudit({
        actorType: "USER", actorId: userId, action: "tenant.created", outcome: "SUCCEEDED",
        resourceType: "tenant", resourceId: tenant.id, requestId,
        metadata: { slug: tenant.slug },
      }, session);
      await enqueueOutboxEvent({
        tenantId: tenant.id, eventType: "tenant.created", schemaVersion: 1,
        aggregateType: "tenant", aggregateId: tenant.id, aggregateVersion: 1,
        visibility: "TENANT_PRIVATE", data: { tenantId: tenant.id, name: tenant.name, slug: tenant.slug },
      }, session);
      return { tenant: tenantDto(tenant), membership: { role: "OWNER" as const, status: "ACTIVE" as const } };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      throw new AppError(409, "TENANT_SLUG_TAKEN", "That organization URL is already in use");
    }
    throw error;
  }
}

export async function listMyTenants(userId: string) {
  const memberships = await Membership.find({ userId, status: "ACTIVE" }).sort({ createdAt: 1 }).lean();
  const tenantIds = memberships.map((membership) => membership.tenantId);
  const tenants = await Tenant.find({ _id: { $in: tenantIds } }).sort({ createdAt: -1 }).lean();
  const membershipByTenant = new Map(memberships.map((membership) => [membership.tenantId.toString(), membership]));
  return tenants.map((tenant) => ({
    tenant: { id: tenant._id.toString(), name: tenant.name, slug: tenant.slug, timezone: tenant.timezone, locale: tenant.locale, status: tenant.status, createdAt: tenant.createdAt },
    membership: { role: membershipByTenant.get(tenant._id.toString())?.role ?? "MEMBER", status: "ACTIVE" },
  }));
}

export async function getTenant(tenantId: string) {
  const tenant = await Tenant.findOne({ _id: tenantId, status: { $ne: "ARCHIVED" } }).lean();
  if (!tenant) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
  return tenantDto({ id: tenant._id.toString(), ...tenant });
}

export async function listTenantMembers(tenantId: string) {
  const memberships = await Membership.find({ tenantId, status: { $in: ["ACTIVE", "INVITED"] } })
    .populate({ path: "userId", select: "displayName email" })
    .sort({ role: 1, createdAt: 1 })
    .lean();
  return memberships.map((membership) => {
    const user = membership.userId as unknown as { _id: { toString(): string }; displayName: string; email: string } | null;
    return {
      user: user ? { id: user._id.toString(), displayName: user.displayName, email: user.email } : null,
      role: membership.role,
      status: membership.status,
      joinedAt: membership.joinedAt,
    };
  }).filter((row) => row.user !== null);
}
