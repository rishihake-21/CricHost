import { z } from "zod";

const idSchema = z.string().regex(/^[a-f\d]{24}$/i).transform((value) => value.toLowerCase());
export const createMatchSchema = z.object({ expectedFixtureVersion: z.number().int().positive() }).strict();
export const startMatchSchema = z.object({
  expectedMatchVersion: z.number().int().positive(),
  tossWinnerTeamId: idSchema,
  tossDecision: z.enum(["BAT", "BOWL"]),
}).strict();
export const assignMatchScorerSchema = z.object({ userId: idSchema }).strict();
export const acquireScorerLeaseSchema = z.object({
  expectedLeaseEpoch: z.number().int().nonnegative(),
  durationSeconds: z.number().int().min(15).max(120).default(45),
  takeoverReason: z.string().trim().min(10).max(500).optional(),
}).strict();
const deliveryFields = {
  strikerId: idSchema,
  bowlerId: idSchema,
  deliveryType: z.enum(["LEGAL", "WIDE", "NO_BALL"]),
  batRuns: z.number().int().min(0).max(6),
  extraType: z.enum(["NONE", "WIDE", "NO_BALL", "BYE", "LEG_BYE"]),
  extraRuns: z.number().int().min(0).max(6),
  completedRuns: z.number().int().min(0).max(6).default(0),
  dismissalType: z.enum(["BOWLED", "CAUGHT", "LBW", "RUN_OUT", "STUMPED", "HIT_WICKET", "OBSTRUCTING_FIELD"]).nullable().default(null),
  dismissedPlayerId: idSchema.nullable().default(null),
};
function validateDelivery(value: { deliveryType: string; extraType: string; extraRuns: number; batRuns: number; completedRuns: number; dismissalType: string | null; dismissedPlayerId: string | null; strikerId: string }, ctx: z.RefinementCtx) {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (value.deliveryType === "LEGAL" && !["NONE", "BYE", "LEG_BYE"].includes(value.extraType)) issue("extraType", "Legal deliveries may only use no extras, byes, or leg byes");
  if (value.deliveryType === "WIDE" && value.extraType !== "WIDE") issue("extraType", "A wide delivery must use WIDE extras");
  if (value.deliveryType === "NO_BALL" && value.extraType !== "NO_BALL") issue("extraType", "A no-ball delivery must use NO_BALL extras");
  if (value.extraType === "NONE" && value.extraRuns !== 0) issue("extraRuns", "A delivery without extras must have zero extra runs");
  if (value.extraType !== "NONE" && value.extraRuns < 1) issue("extraRuns", "The selected extra type requires at least one extra run");
  if (value.completedRuns > value.batRuns + value.extraRuns) issue("completedRuns", "Completed runs cannot exceed the total runs recorded on the delivery");
  if (value.deliveryType === "WIDE" && value.batRuns !== 0) issue("batRuns", "Bat runs cannot be recorded from a wide delivery");
  if ((value.dismissalType === null) !== (value.dismissedPlayerId === null)) issue("dismissedPlayerId", "Dismissal type and dismissed player must be supplied together");
  if (value.dismissalType && ["BOWLED", "CAUGHT", "LBW", "STUMPED", "HIT_WICKET"].includes(value.dismissalType) && value.deliveryType === "NO_BALL") issue("dismissalType", "This dismissal is not valid from a no-ball");
  if (value.dismissalType && ["BOWLED", "CAUGHT", "LBW"].includes(value.dismissalType) && value.deliveryType === "WIDE") issue("dismissalType", "This dismissal is not valid from a wide");
  if (value.dismissalType && value.dismissedPlayerId !== value.strikerId) issue("dismissedPlayerId", "This scoring slice can only record dismissal of the striker");
}
const deliveryInterpretationSchema = z.object(deliveryFields).strict().superRefine(validateDelivery);
export const appendDeliverySchema = z.object({
  clientEventId: z.string().uuid().transform((value) => value.toLowerCase()),
  expectedSequence: z.number().int().nonnegative(),
  leaseEpoch: z.number().int().positive(),
  ...deliveryFields,
}).strict().superRefine(validateDelivery);
export const correctDeliverySchema = z.object({
  clientEventId: z.string().uuid().transform((value) => value.toLowerCase()),
  expectedSequence: z.number().int().nonnegative(),
  expectedInningsVersion: z.number().int().positive(),
  targetEventId: idSchema,
  reason: z.string().trim().min(10).max(500),
  revisedDelivery: deliveryInterpretationSchema,
}).strict();

export const closeInningsSchema = z.object({ expectedInningsVersion: z.number().int().positive(), reason: z.string().trim().min(10).max(500) }).strict();
export const startNextInningsSchema = z.object({ expectedMatchVersion: z.number().int().positive(), battingTeamId: idSchema }).strict();
export const completeMatchSchema = z.object({
  expectedMatchVersion: z.number().int().positive(),
  outcome: z.enum(["HOME_WIN", "AWAY_WIN", "TIE", "NO_RESULT"]),
  reason: z.string().trim().min(10).max(500),
}).strict();
export const listDeliveriesQuerySchema = z.object({ afterSequence: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

export type AppendDeliveryInput = z.infer<typeof appendDeliverySchema>;
export type DeliveryInterpretationInput = z.infer<typeof deliveryInterpretationSchema>;
export type CorrectDeliveryInput = z.infer<typeof correctDeliverySchema>;
