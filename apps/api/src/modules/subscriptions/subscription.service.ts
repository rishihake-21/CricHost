import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { SubscriptionPlan } from "./models/subscription-plan.model.js";
import { TenantSubscription } from "./models/tenant-subscription.model.js";
import { assignPlanSchema, planDefinitionSchema } from "./subscription.schemas.js";
import { z } from "zod";

export type PlanDefinition = z.infer<typeof planDefinitionSchema>;
export type PlanAssignment = z.input<typeof assignPlanSchema>;

function subscriptionDto(subscription: {
  tenantId: Types.ObjectId; planCode: string | null; planVersion: number | null; status: string;
  limitsSnapshot: unknown; featuresSnapshot: string[]; currentPeriodStart: Date | null; currentPeriodEnd: Date | null;
  billingProvider: string; aggregateVersion: number; updatedAt: Date;
}) {
  return {
    tenantId: subscription.tenantId.toString(), planCode: subscription.planCode,
    planVersion: subscription.planVersion, status: subscription.status,
    limits: subscription.limitsSnapshot ?? null, features: subscription.featuresSnapshot,
    currentPeriodStart: subscription.currentPeriodStart, currentPeriodEnd: subscription.currentPeriodEnd,
    billingProvider: subscription.billingProvider, version: subscription.aggregateVersion, updatedAt: subscription.updatedAt,
  };
}

/** Internal provisioning entry point. Platform admin and billing adapters are not exposed over HTTP yet. */
export async function defineSubscriptionPlan(input: PlanDefinition, requestId: string, actor: { type: "USER" | "SYSTEM"; id?: string }) {
  input = planDefinitionSchema.parse(input);
  if (actor.type === "USER" && !actor.id) throw new AppError(400, "SUBSCRIPTION_ACTOR_REQUIRED", "User initiated plan changes require an actor ID");
  return withTransaction(async (session: ClientSession) => {
    const existing = await SubscriptionPlan.findOne({ code: input.code, version: input.version }).session(session);
    if (existing) {
      const sameDefinition = existing.name === input.name
        && JSON.stringify(existing.limits) === JSON.stringify(input.limits)
        && JSON.stringify(existing.features) === JSON.stringify(input.features);
      if (!sameDefinition) throw new AppError(409, "PLAN_VERSION_IMMUTABLE", "A plan version is immutable once created; publish a new version");
      const allowedStatusTransition = (existing.status === "DRAFT" && ["ACTIVE", "RETIRED"].includes(input.status))
        || (existing.status === "ACTIVE" && input.status === "RETIRED");
      if (existing.status !== input.status && !allowedStatusTransition) {
        throw new AppError(409, "PLAN_STATUS_TRANSITION_INVALID", "Plan status cannot move to the requested state");
      }
      if (existing.status !== input.status) {
        const previousStatus = existing.status;
        existing.status = input.status;
        await existing.save({ session });
        await recordAudit({ actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: "subscription.plan_status_changed", outcome: "SUCCEEDED", resourceType: "subscription_plan", resourceId: `${existing.code}:${existing.version}`, requestId, metadata: { code: existing.code, version: existing.version, previousStatus, status: existing.status } }, session);
      }
      return { code: existing.code, version: existing.version, status: existing.status };
    }
    const [plan] = await SubscriptionPlan.create([{
      code: input.code, version: input.version, name: input.name, status: input.status,
      limits: input.limits, features: input.features,
    }], { session });
    if (!plan) throw new Error("Plan creation returned no record");
    await recordAudit({ actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), action: "subscription.plan_defined", outcome: "SUCCEEDED", resourceType: "subscription_plan", resourceId: `${plan.code}:${plan.version}`, requestId, metadata: { code: plan.code, version: plan.version, status: plan.status } }, session);
    return { code: plan.code, version: plan.version, status: plan.status };
  });
}

/** Assigns a versioned plan snapshot; intended for a future platform-admin route or billing webhook. */
export async function assignTenantPlan(tenantId: string, input: PlanAssignment, requestId: string, actor: { type: "USER" | "SYSTEM"; id?: string }) {
  if (!Types.ObjectId.isValid(tenantId) || !/^[a-f\d]{24}$/i.test(tenantId)) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
  const assignment = assignPlanSchema.parse(input);
  if (actor.type === "USER" && !actor.id) throw new AppError(400, "SUBSCRIPTION_ACTOR_REQUIRED", "User initiated subscription changes require an actor ID");
  const periodStart = new Date(assignment.currentPeriodStart);
  const periodEnd = new Date(assignment.currentPeriodEnd);
  return withTransaction(async (session: ClientSession) => {
    const planQuery = SubscriptionPlan.findOne({ code: assignment.planCode, status: "ACTIVE", ...(assignment.planVersion ? { version: assignment.planVersion } : {}) }).sort({ version: -1 }).session(session);
    const plan = await planQuery;
    if (!plan) throw new AppError(404, "ACTIVE_PLAN_NOT_FOUND", "Active subscription plan was not found");
    const subscription = await TenantSubscription.findOne({ tenantId }).session(session);
    if (!subscription) throw new AppError(404, "TENANT_SUBSCRIPTION_NOT_FOUND", "Subscription record was not found");
    subscription.planId = plan._id;
    subscription.planCode = plan.code;
    subscription.planVersion = plan.version;
    subscription.status = assignment.status;
    subscription.limitsSnapshot = plan.limits;
    subscription.featuresSnapshot = plan.features;
    subscription.currentPeriodStart = periodStart;
    subscription.currentPeriodEnd = periodEnd;
    subscription.billingProvider = assignment.billingProvider;
    subscription.aggregateVersion += 1;
    await subscription.save({ session });
    await recordAudit({ actorType: actor.type, ...(actor.id ? { actorId: actor.id } : {}), tenantId, action: "subscription.plan_assigned", outcome: "SUCCEEDED", resourceType: "tenant_subscription", resourceId: subscription.id, requestId, reason: assignment.reason, metadata: { planCode: plan.code, planVersion: plan.version, status: subscription.status, periodStart, periodEnd } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "subscription.plan_assigned", schemaVersion: 1, aggregateType: "tenant_subscription", aggregateId: subscription.id, aggregateVersion: subscription.aggregateVersion, visibility: "TENANT_PRIVATE", data: { planCode: plan.code, planVersion: plan.version, status: subscription.status, version: subscription.aggregateVersion } }, session);
    return subscriptionDto(subscription as unknown as Parameters<typeof subscriptionDto>[0]);
  });
}

export async function getTenantSubscription(tenantId: string) {
  if (!Types.ObjectId.isValid(tenantId) || !/^[a-f\d]{24}$/i.test(tenantId)) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
  const subscription = await TenantSubscription.findOne({ tenantId }).lean();
  if (!subscription) return { tenantId, planCode: null, planVersion: null, status: "UNCONFIGURED", limits: null, features: [], currentPeriodStart: null, currentPeriodEnd: null, billingProvider: "NONE", version: 0, updatedAt: null };
  return subscriptionDto(subscription as unknown as Parameters<typeof subscriptionDto>[0]);
}
