import { z } from "zod";

export const applyRegistrationSchema = z.object({ consentToParticipate: z.literal(true) }).strict();
export const registrationDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().min(10).max(500).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.decision === "REJECT" && !value.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "A reason is required when rejecting an application" });
});
export type RegistrationDecision = z.infer<typeof registrationDecisionSchema>;
