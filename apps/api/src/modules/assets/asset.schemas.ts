import { z } from "zod";

const idSchema = z.string().regex(/^[a-f\d]{24}$/i).transform((value) => value.toLowerCase());
export const createAssetUploadIntentSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  purpose: z.enum(["SPONSOR_LOGO", "CAMPAIGN_CREATIVE", "TEAM_BRANDING", "OTHER"]),
  contentType: z.enum(["image/jpeg", "image/png"]),
  expectedSizeBytes: z.number().int().positive().max(25 * 1024 * 1024).optional(),
}).strict();

export const assetListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  beforeId: idSchema.optional(),
  status: z.enum(["PENDING_UPLOAD", "UPLOADING", "PENDING_SCAN", "PENDING_REVIEW", "APPROVED", "REJECTED", "DELETED"]).optional(),
}).strict();

export const scanAssetSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const reviewAssetSchema = z.object({
  expectedVersion: z.number().int().positive(),
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().trim().min(10).max(500),
}).strict();

export type CreateAssetUploadIntentInput = z.infer<typeof createAssetUploadIntentSchema>;
