import { z } from "zod";

export const createTeamSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  shortName: z.string().trim().max(20).default(""),
}).strict();

export const assignTeamStaffSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i),
  role: z.enum(["MANAGER", "BIDDER"]),
}).strict();

export const addRosterEntrySchema = z.object({
  registrationId: z.string().regex(/^[a-f\d]{24}$/i),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500).optional(),
}).strict();

export const releaseRosterEntrySchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
}).strict();
