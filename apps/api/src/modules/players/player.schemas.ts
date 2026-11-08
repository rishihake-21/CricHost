import { z } from "zod";

const formats = ["T10", "T20", "ODI", "TEST", "CUSTOM"] as const;
const role = ["BATTER", "BOWLER", "ALL_ROUNDER", "WICKETKEEPER", "UNKNOWN"] as const;
const hand = ["LEFT", "RIGHT", "UNKNOWN"] as const;
const bowling = ["RIGHT_ARM_FAST", "RIGHT_ARM_MEDIUM", "RIGHT_ARM_OFF_BREAK", "RIGHT_ARM_LEG_BREAK", "LEFT_ARM_FAST", "LEFT_ARM_MEDIUM", "LEFT_ARM_ORTHODOX", "LEFT_ARM_WRIST_SPIN", "NONE", "OTHER", "UNKNOWN"] as const;

export const createPlayerProfileSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  bio: z.string().trim().max(500).default(""),
  locationLabel: z.string().trim().max(80).default(""),
  playingRole: z.enum(role),
  battingHand: z.enum(hand),
  bowlingStyle: z.enum(bowling),
  wicketkeeper: z.boolean().default(false),
  preferredFormats: z.array(z.enum(formats)).max(5).default([]).refine((values) => new Set(values).size === values.length, "Formats must be unique"),
  visibility: z.enum(["PUBLIC", "TOURNAMENTS_ONLY", "PRIVATE"]).default("TOURNAMENTS_ONLY"),
  consentToCreateProfile: z.literal(true),
}).strict();

export const updatePlayerProfileSchema = createPlayerProfileSchema.omit({ consentToCreateProfile: true }).extend({ expectedVersion: z.number().int().positive(), consentToVisibility: z.literal(true) }).strict();
export type CreatePlayerProfileInput = z.infer<typeof createPlayerProfileSchema>;
export type UpdatePlayerProfileInput = z.infer<typeof updatePlayerProfileSchema>;
