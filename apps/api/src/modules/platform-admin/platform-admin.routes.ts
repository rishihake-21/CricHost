import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { AppError } from "../../platform/errors/app-error.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { recordAudit } from "../audit/audit.service.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { listDeadOutboxEvents, requeueDeadOutboxEvent } from "../outbox/outbox.service.js";
import { assignTenantPlan, defineSubscriptionPlan, getTenantSubscription, listSubscriptionPlans } from "../subscriptions/subscription.service.js";
import { assignPlanSchema, planDefinitionSchema } from "../subscriptions/subscription.schemas.js";
import { requireAllowlistedPlatformIdentity, requirePlatformAdminStepUp } from "./platform-admin.authorization.js";
import { beginPlatformMfaEnrollment, confirmPlatformMfaEnrollment, getPlatformMfaStatus, verifyPlatformAdminStepUp } from "./platform-admin.service.js";

export const platformAdminRouter = Router();

const limiter = (windowMs: number, max: number) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many MFA attempts. Try again later.", requestId: res.locals.requestId } }),
});
const enrollmentLimiter = limiter(60 * 60_000, 3);
const mfaAttemptLimiter = limiter(15 * 60_000, 5);

const enrollmentSchema = z.object({ password: z.string().min(1).max(100) }).strict();
const codeSchema = z.object({ code: z.string().trim().regex(/^(?:\d{6}|[a-f\d-]{32,39})$/i) }).strict();
const requeueSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const listLimitSchema = z.coerce.number().int().min(1).max(100).default(50);

platformAdminRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});
platformAdminRouter.use(requireIdentity, requireAllowlistedPlatformIdentity);

platformAdminRouter.get("/mfa/status", asyncHandler(async (_req, res) => {
  const principal = res.locals.principal as { id: string };
  const status = await getPlatformMfaStatus(principal.id);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { mfa: status }, meta: { requestId: res.locals.requestId } });
}));

platformAdminRouter.post("/mfa/enroll", enrollmentLimiter, asyncHandler(async (req, res) => {
  const parsed = enrollmentSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Password confirmation is invalid");
  const principal = res.locals.principal as { id: string };
  const enrollment = await beginPlatformMfaEnrollment(principal.id, parsed.data.password, String(res.locals.requestId));
  res.setHeader("Cache-Control", "private, no-store");
  res.status(201).json({ data: { enrollment }, meta: { requestId: res.locals.requestId } });
}));

platformAdminRouter.post("/mfa/confirm", mfaAttemptLimiter, asyncHandler(async (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Provide a six-digit authenticator code");
  if (!/^\d{6}$/.test(parsed.data.code)) throw new AppError(400, "VALIDATION_FAILED", "Provide a six-digit authenticator code");
  const principal = res.locals.principal as { id: string };
  const confirmation = await confirmPlatformMfaEnrollment(principal.id, parsed.data.code, String(res.locals.requestId));
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { confirmation }, meta: { requestId: res.locals.requestId } });
}));

platformAdminRouter.post("/mfa/verify", mfaAttemptLimiter, asyncHandler(async (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "MFA code is invalid");
  const principal = res.locals.principal as { id: string };
  const sessionId = res.locals.authSessionId as string | undefined;
  if (!sessionId) throw new AppError(401, "INVALID_SESSION", "The session is invalid or expired");
  const verification = await verifyPlatformAdminStepUp(principal.id, sessionId, parsed.data.code, String(res.locals.requestId));
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { verification }, meta: { requestId: res.locals.requestId } });
}));

platformAdminRouter.use(requirePlatformAdminStepUp);

platformAdminRouter.get("/plans", asyncHandler(async (_req, res) => {
  const principal = res.locals.principal as { id: string };
  const plans = await listSubscriptionPlans();
  await recordAudit({ actorType: "USER", actorId: principal.id, action: "subscription.plans.listed", outcome: "SUCCEEDED", resourceType: "subscription_plan_catalog", resourceId: "catalog", requestId: String(res.locals.requestId), metadata: { count: plans.length } });
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { plans }, meta: { requestId: res.locals.requestId, count: plans.length } });
}));

platformAdminRouter.post("/plans", asyncHandler(async (req, res) => {
  const parsed = planDefinitionSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Plan definition is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const result = await defineSubscriptionPlan(parsed.data, String(res.locals.requestId), { type: "USER", id: principal.id });
  res.json({ data: { plan: result }, meta: { requestId: res.locals.requestId } });
}));

platformAdminRouter.get("/tenants/:tenantId/subscription", asyncHandler(async (req, res) => {
  const principal = res.locals.principal as { id: string };
  const subscription = await getTenantSubscription(req.params.tenantId);
  await recordAudit({ actorType: "USER", actorId: principal.id, tenantId: req.params.tenantId, action: "subscription.platform_read", outcome: "SUCCEEDED", resourceType: "tenant_subscription", resourceId: req.params.tenantId, requestId: String(res.locals.requestId), metadata: { status: subscription.status, planCode: subscription.planCode } });
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { subscription }, meta: { requestId: res.locals.requestId } });
}));

platformAdminRouter.post("/tenants/:tenantId/subscription", asyncHandler(async (req, res) => {
  const parsed = assignPlanSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Subscription assignment is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const subscription = await assignTenantPlan(req.params.tenantId, parsed.data, String(res.locals.requestId), { type: "USER", id: principal.id });
  res.json({ data: { subscription }, meta: { requestId: res.locals.requestId } });
}));

platformAdminRouter.get("/outbox/dead-letters", asyncHandler(async (req, res) => {
  const parsedLimit = listLimitSchema.safeParse(req.query.limit ?? 50);
  if (!parsedLimit.success) throw new AppError(400, "VALIDATION_FAILED", "limit must be an integer from 1 to 100");
  const principal = res.locals.principal as { id: string };
  const events = await listDeadOutboxEvents(parsedLimit.data);
  await recordAudit({ actorType: "USER", actorId: principal.id, action: "outbox.dead_letters.listed", outcome: "SUCCEEDED", resourceType: "outbox_dead_letter_queue", resourceId: "dead-letters", requestId: String(res.locals.requestId), metadata: { count: events.length, limit: parsedLimit.data } });
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { events }, meta: { requestId: res.locals.requestId, limit: parsedLimit.data, count: events.length } });
}));

platformAdminRouter.post("/outbox/dead-letters/:eventId/requeue", asyncHandler(async (req, res) => {
  const parsed = requeueSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "A reason is required to replay a dead-letter event");
  const principal = res.locals.principal as { id: string };
  const result = await requeueDeadOutboxEvent({ eventId: req.params.eventId, actorType: "USER", actorId: principal.id, requestId: String(res.locals.requestId), reason: parsed.data.reason });
  res.json({ data: { event: result }, meta: { requestId: res.locals.requestId } });
}));

platformAdminRouter.all("*", (_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Resource was not found")));
