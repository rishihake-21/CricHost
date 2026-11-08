import { Router, type Request, type Response } from "express";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { env } from "../../platform/config/env.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { assetListQuerySchema, createAssetUploadIntentSchema, reviewAssetSchema, scanAssetSchema } from "./asset.schemas.js";
import { createAssetUploadIntent, getAsset, getAssetContent, listAssets, receiveAssetUpload, reviewAsset, scanAsset } from "./asset.service.js";

export const assetRouter = Router();
const uploadRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many asset uploads. Try again later.", requestId: res.locals.requestId } }),
});
const intentRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many asset upload intents. Try again later.", requestId: res.locals.requestId } }),
});

// A short-lived signed upload token is the only authorization for this raw body route.
assetRouter.put("/:tenantId/assets/:assetId/content", uploadRateLimiter, express.raw({ type: "*/*", limit: env.ASSET_MAX_UPLOAD_BYTES }), asyncHandler(async (req, res) => {
  const token = req.header("X-Asset-Upload-Token");
  if (!token) throw new AppError(401, "ASSET_UPLOAD_TOKEN_REQUIRED", "Upload authorization is required");
  if (!Buffer.isBuffer(req.body)) throw new AppError(400, "ASSET_UPLOAD_BODY_INVALID", "Upload body must contain raw image bytes");
  const asset = await receiveAssetUpload(req.params.tenantId, req.params.assetId, token, req.header("Content-Type") ?? "", req.body, String(res.locals.requestId));
  res.setHeader("Cache-Control", "no-store");
  res.status(202).json({ data: { asset }, meta: { requestId: res.locals.requestId } });
}));

// All remaining routes require a verified identity and active organization membership.
assetRouter.use(requireIdentity, requireVerifiedIdentity);

assetRouter.post("/:tenantId/assets/upload-intents", intentRateLimiter, requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = createAssetUploadIntentSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Asset upload intent is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const intent = await createAssetUploadIntent(req.params.tenantId, principal.id, String(res.locals.requestId), parsed.data);
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ data: intent, meta: { requestId: res.locals.requestId } });
}));

assetRouter.get("/:tenantId/assets", requireTenantMembership(), asyncHandler(async (req, res) => {
  const parsed = assetListQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Asset list query is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const result = await listAssets(req.params.tenantId, parsed.data.limit, parsed.data.beforeId, parsed.data.status);
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: result, meta: { requestId: res.locals.requestId, count: result.assets.length } });
}));

assetRouter.get("/:tenantId/assets/:assetId", requireTenantMembership(), asyncHandler(async (req, res) => {
  const asset = await getAsset(req.params.tenantId, req.params.assetId);
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: { asset }, meta: { requestId: res.locals.requestId } });
}));

assetRouter.get("/:tenantId/assets/:assetId/content", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const content = await getAssetContent(req.params.tenantId, req.params.assetId);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Content-Type", content.contentType);
  res.setHeader("Content-Length", String(content.bytes.length));
  res.setHeader("Content-Disposition", "inline");
  res.status(200).send(content.bytes);
}));

assetRouter.post("/:tenantId/assets/:assetId/scan", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = scanAssetSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Asset scan request is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const asset = await scanAsset(req.params.tenantId, req.params.assetId, principal.id, String(res.locals.requestId), parsed.data.expectedVersion);
  res.json({ data: { asset }, meta: { requestId: res.locals.requestId } });
}));

assetRouter.post("/:tenantId/assets/:assetId/review", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = reviewAssetSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Asset review requires a decision, current version and reason", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const asset = await reviewAsset(req.params.tenantId, req.params.assetId, principal.id, String(res.locals.requestId), parsed.data);
  res.json({ data: { asset }, meta: { requestId: res.locals.requestId } });
}));
