import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const httpsUrl = z.string().url().max(500).refine((value) => new URL(value).protocol === "https:", "URL must use HTTPS");
const placement = z.enum(["TOURNAMENT_HEADER", "FIXTURE_LIST", "MATCH_PAGE", "SCORECARD"]);

export const createSponsorSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  description: z.string().trim().max(1000).default(""),
  websiteUrl: httpsUrl.optional(),
  logoAssetId: objectId.optional(),
}).strict();
export type CreateSponsorInput = z.infer<typeof createSponsorSchema>;

export const updateSponsorSchema = z.object({
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  websiteUrl: httpsUrl.nullable().optional(),
  logoAssetId: objectId.nullable().optional(),
}).strict().refine(({ expectedVersion: _version, ...fields }) => Object.keys(fields).length > 0, "At least one field must be changed");
export type UpdateSponsorInput = z.infer<typeof updateSponsorSchema>;

export const createCampaignSchema = z.object({
  sponsorId: objectId,
  assetId: objectId,
  placement,
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  targetUrl: httpsUrl,
}).strict().refine((value) => new Date(value.startsAt) < new Date(value.endsAt), { message: "Campaign end must be after its start", path: ["endsAt"] });
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = z.object({
  expectedVersion: z.number().int().positive(),
  assetId: objectId.optional(),
  placement: placement.optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
  targetUrl: httpsUrl.optional(),
}).strict().refine(({ expectedVersion: _version, ...fields }) => Object.keys(fields).length > 0, "At least one field must be changed");
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

export const campaignActionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  action: z.enum(["PAUSE", "RESUME", "CANCEL"]),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const sponsorListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
export const campaignListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(["SCHEDULED", "PAUSED", "CANCELLED"]).optional(),
}).strict();
export const publicSponsorQuerySchema = z.object({ placement: placement.optional() }).strict();
