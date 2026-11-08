import { z } from "zod";

export const generateFixturesSchema = z.object({
  expectedTournamentVersion: z.number().int().positive(),
  seed: z.string().trim().min(1).max(100),
  scheduleStartAt: z.string().datetime({ offset: true }),
  intervalMinutes: z.number().int().min(30).max(1440),
  durationMinutes: z.number().int().min(30).max(720),
}).strict().refine((value) => value.intervalMinutes >= value.durationMinutes, { path: ["intervalMinutes"], message: "Interval must be at least the match duration" });

export type GenerateFixturesInput = z.infer<typeof generateFixturesSchema>;
