import { z } from "zod";

export const enforcedPlanQuotaMetrics = [
  "activeTournaments",
  "activeMembers",
  "teamsPerTournament",
  "registrationsPerTournament",
  "assetStorageBytes",
  "sponsorCampaignsPerTournament",
] as const;

export const planDefinitionSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]*$/).max(40),
  version: z.number().int().positive(),
  name: z.string().trim().min(2).max(100),
  status: z.enum(["DRAFT", "ACTIVE", "RETIRED"]),
  limits: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/).max(60), z.number().int().nonnegative().nullable()),
  features: z.array(z.string().regex(/^[a-z][a-zA-Z0-9._-]*$/).max(80)).max(100),
}).strict().superRefine((plan, context) => {
  if (plan.status === "DRAFT") return;
  for (const metric of enforcedPlanQuotaMetrics) {
    if (!Object.hasOwn(plan.limits, metric)) {
      context.addIssue({ code: "custom", message: `Active plan must configure ${metric}; use null for unmetered`, path: ["limits", metric] });
    }
  }
});

export const assignPlanSchema = z.object({
  planCode: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]*$/).max(40),
  planVersion: z.number().int().positive().optional(),
  status: z.enum(["TRIAL", "ACTIVE"]),
  billingProvider: z.enum(["NONE", "STRIPE", "OTHER"]).default("NONE"),
  currentPeriodStart: z.string().datetime({ offset: true }),
  currentPeriodEnd: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(3).max(500),
}).strict().refine((subscription) => new Date(subscription.currentPeriodStart) < new Date(subscription.currentPeriodEnd), { message: "Subscription end must be after its start", path: ["currentPeriodEnd"] });
