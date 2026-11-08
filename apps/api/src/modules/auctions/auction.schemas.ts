import { z } from "zod";

const auctionRulesSchema = z.object({
  purseBudget: z.number().int().min(1).max(1_000_000_000),
  purseUnitLabel: z.string().trim().min(1).max(20).default("credits"),
  basePrice: z.number().int().min(1).max(1_000_000_000),
  minimumIncrement: z.number().int().min(1).max(1_000_000_000),
  lotDurationSeconds: z.number().int().min(10).max(3600).default(60),
  antiSnipingExtensionSeconds: z.number().int().min(0).max(300).default(0),
  antiSnipingMaxExtensions: z.number().int().min(0).max(20).default(0),
  unsoldPolicy: z.enum(["CLOSE", "REOFFER"]).default("CLOSE"),
  maxUnsoldReoffers: z.number().int().min(0).max(5).default(0),
}).strict().superRefine((value, ctx) => {
  if (value.basePrice > value.purseBudget) ctx.addIssue({ code: "custom", path: ["basePrice"], message: "Base price cannot exceed the purse budget" });
  if (value.minimumIncrement > value.purseBudget) ctx.addIssue({ code: "custom", path: ["minimumIncrement"], message: "Minimum increment cannot exceed the purse budget" });
  if ((value.antiSnipingExtensionSeconds === 0) !== (value.antiSnipingMaxExtensions === 0)) ctx.addIssue({ code: "custom", path: ["antiSnipingMaxExtensions"], message: "Set both anti-sniping fields to zero to disable extensions" });
  if (value.unsoldPolicy === "CLOSE" && value.maxUnsoldReoffers > 0) ctx.addIssue({ code: "custom", path: ["maxUnsoldReoffers"], message: "Set maxUnsoldReoffers to zero when the unsold policy is CLOSE" });
  if (value.unsoldPolicy === "REOFFER" && value.maxUnsoldReoffers === 0) ctx.addIssue({ code: "custom", path: ["maxUnsoldReoffers"], message: "REOFFER policy requires at least one allowed reoffer" });
});

export const createAuctionSchema = z.object({
  expectedTournamentVersion: z.number().int().positive(),
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  rules: auctionRulesSchema,
}).strict();

export const assignAuctionBidderSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i),
}).strict();

export const removeAuctionBidderSchema = z.object({
  reason: z.string().trim().min(10).max(500),
}).strict();

export const cancelAuctionSchema = z.object({
  expectedAuctionVersion: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
}).strict();

export const generateAuctionPoolSchema = z.object({
  expectedAuctionVersion: z.number().int().positive(),
  seed: z.string().trim().min(1).max(100),
}).strict();

export const scheduleAuctionSchema = z.object({
  expectedAuctionVersion: z.number().int().positive(),
  scheduledAt: z.string().datetime({ offset: true }),
}).strict();

export const startAuctionSchema = z.object({
  expectedAuctionVersion: z.number().int().positive(),
}).strict();

export const pauseAuctionSchema = z.object({
  expectedAuctionVersion: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
}).strict();

export const resumeAuctionSchema = z.object({
  expectedAuctionVersion: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
}).strict();

export const openNextLotSchema = z.object({
  expectedAuctionVersion: z.number().int().positive(),
}).strict();

export const placeAuctionBidSchema = z.object({
  teamId: z.string().regex(/^[a-f\d]{24}$/i),
  amount: z.number().int().min(1).max(1_000_000_000),
  expectedLotVersion: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
}).strict();

export const finalizeAuctionLotSchema = z.object({
  expectedLotVersion: z.number().int().positive(),
}).strict();

export const auctionBidHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  beforeSequence: z.coerce.number().int().positive().optional(),
}).strict();

export const publicAuctionCatalogueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  afterLotNumber: z.coerce.number().int().min(0).optional(),
}).strict();

export const publicAuctionResultsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  beforeId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
}).strict();

export type CreateAuctionInput = z.infer<typeof createAuctionSchema>;
export type AssignAuctionBidderInput = z.infer<typeof assignAuctionBidderSchema>;
export type GenerateAuctionPoolInput = z.infer<typeof generateAuctionPoolSchema>;
export type PlaceAuctionBidInput = z.infer<typeof placeAuctionBidSchema>;
