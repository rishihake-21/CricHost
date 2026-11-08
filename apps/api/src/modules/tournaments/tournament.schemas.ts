import { z } from "zod";

const standardOvers: Record<string, number> = { T10: 10, T20: 20, ODI: 50 };
const rulesSchema = z.object({
  inningsPerMatch: z.number().int().min(1).max(4),
  oversPerInnings: z.number().positive().max(100).nullable(),
  ballsPerOver: z.number().int().min(4).max(8).default(6),
  playersPerSide: z.number().int().min(2).max(15).default(11),
  minimumSquadSize: z.number().int().min(2).max(30).default(11),
  maximumSquadSize: z.number().int().min(2).max(30).default(20),
  followOnEnabled: z.boolean().default(false),
  tiePolicy: z.enum(["SUPER_OVER", "DRAW", "REPLAY", "POINTS"]).default("SUPER_OVER"),
  pointsForWin: z.number().int().min(0).max(10).default(2),
  pointsForTie: z.number().int().min(0).max(10).default(1),
  pointsForNoResult: z.number().int().min(0).max(10).default(1),
}).strict();

export const createTournamentSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  season: z.string().trim().min(1).max(40),
  description: z.string().trim().max(2000).default(""),
  timezone: z.string().trim().min(1).max(80),
  locale: z.string().trim().min(2).max(35).default("en-US"),
  visibility: z.enum(["PRIVATE", "PUBLIC"]).default("PRIVATE"),
  registrationOpensAt: z.string().datetime({ offset: true }),
  registrationClosesAt: z.string().datetime({ offset: true }),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  format: z.enum(["T10", "T20", "ODI", "TEST", "CUSTOM"]),
  structure: z.enum(["KNOCKOUT", "ROUND_ROBIN", "GROUP_KNOCKOUT"]),
  rules: rulesSchema,
}).strict().superRefine((value, ctx) => {
  const open = Date.parse(value.registrationOpensAt);
  const close = Date.parse(value.registrationClosesAt);
  const start = Date.parse(value.startAt);
  const end = Date.parse(value.endAt);
  if (!(open < close && close < start && start < end)) ctx.addIssue({ code: "custom", path: ["startAt"], message: "Dates must be ordered registration open, registration close, tournament start, tournament end" });
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.timezone }); }
  catch { ctx.addIssue({ code: "custom", path: ["timezone"], message: "Timezone must be a valid IANA timezone" }); }
  try { Intl.getCanonicalLocales(value.locale); }
  catch { ctx.addIssue({ code: "custom", path: ["locale"], message: "Locale must be a valid BCP 47 locale" }); }
  if (value.rules.minimumSquadSize < value.rules.playersPerSide) ctx.addIssue({ code: "custom", path: ["rules", "minimumSquadSize"], message: "Minimum squad size cannot be smaller than players per side" });
  if (value.rules.maximumSquadSize < value.rules.minimumSquadSize) ctx.addIssue({ code: "custom", path: ["rules", "maximumSquadSize"], message: "Maximum squad size cannot be smaller than minimum squad size" });
  if (value.format !== "TEST" && value.rules.followOnEnabled) ctx.addIssue({ code: "custom", path: ["rules", "followOnEnabled"], message: "Follow-on is only applicable to Test matches" });
  if (value.format === "TEST") {
    if (value.rules.oversPerInnings !== null) ctx.addIssue({ code: "custom", path: ["rules", "oversPerInnings"], message: "Test matches use time/innings limits rather than a fixed overs limit" });
    if (![2, 4].includes(value.rules.inningsPerMatch)) ctx.addIssue({ code: "custom", path: ["rules", "inningsPerMatch"], message: "Test matches must configure two or four innings" });
  } else {
    if (value.rules.oversPerInnings === null) ctx.addIssue({ code: "custom", path: ["rules", "oversPerInnings"], message: "Limited overs formats require an overs limit" });
    if (value.rules.inningsPerMatch !== 2) ctx.addIssue({ code: "custom", path: ["rules", "inningsPerMatch"], message: "Limited overs formats use two innings" });
    const expected = standardOvers[value.format];
    if (expected && value.rules.oversPerInnings !== expected) ctx.addIssue({ code: "custom", path: ["rules", "oversPerInnings"], message: `${value.format} uses ${expected} overs per innings` });
  }
});

export const updateTournamentRulesSchema = z.object({
  expectedVersion: z.number().int().positive(),
  rules: rulesSchema,
}).strict();

export const transitionTournamentSchema = z.object({
  targetStatus: z.enum(["REGISTRATION_OPEN", "REGISTRATION_CLOSED"]),
  reason: z.string().trim().min(10).max(500).optional(),
}).strict();

export type CreateTournamentInput = z.infer<typeof createTournamentSchema>;
export type TournamentRules = z.infer<typeof rulesSchema>;
