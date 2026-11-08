import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { AppError } from "../../platform/errors/app-error.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { campaignActionSchema, campaignListQuerySchema, createCampaignSchema, createSponsorSchema, publicSponsorQuerySchema, sponsorListQuerySchema, updateCampaignSchema, updateSponsorSchema } from "./sponsor.schemas.js";
import { changeCampaignState, createCampaign, createSponsor, getPublicSponsorCreative, getPublicSponsorLogo, listCampaigns, listPublicSponsorPlacements, listSponsors, updateCampaign, updateSponsor } from "./sponsor.service.js";

export const sponsorRouter = Router();
sponsorRouter.use(requireIdentity, requireVerifiedIdentity);

sponsorRouter.post("/:tenantId/sponsors", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = createSponsorSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Sponsor details are invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const sponsor = await createSponsor(req.params.tenantId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: { sponsor }, meta: { requestId: res.locals.requestId } });
}));

sponsorRouter.get("/:tenantId/sponsors", requireTenantMembership(), asyncHandler(async (req, res) => {
  const parsed = sponsorListQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Sponsor list query is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const sponsors = await listSponsors(req.params.tenantId, parsed.data.limit);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { sponsors }, meta: { requestId: res.locals.requestId, count: sponsors.length } });
}));

sponsorRouter.patch("/:tenantId/sponsors/:sponsorId", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = updateSponsorSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Sponsor update is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const sponsor = await updateSponsor(req.params.tenantId, req.params.sponsorId, principal.id, String(res.locals.requestId), parsed.data);
  res.json({ data: { sponsor }, meta: { requestId: res.locals.requestId } });
}));

sponsorRouter.post("/:tenantId/tournaments/:tournamentId/sponsor-campaigns", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Campaign details are invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const campaign = await createCampaign(req.params.tenantId, req.params.tournamentId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: { campaign }, meta: { requestId: res.locals.requestId } });
}));

sponsorRouter.get("/:tenantId/tournaments/:tournamentId/sponsor-campaigns", requireTenantMembership(), asyncHandler(async (req, res) => {
  const parsed = campaignListQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Campaign list query is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const campaigns = await listCampaigns(req.params.tenantId, req.params.tournamentId, parsed.data.limit, parsed.data.status);
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ data: { campaigns }, meta: { requestId: res.locals.requestId, count: campaigns.length } });
}));

sponsorRouter.patch("/:tenantId/tournaments/:tournamentId/sponsor-campaigns/:campaignId", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = updateCampaignSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Campaign update is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const campaign = await updateCampaign(req.params.tenantId, req.params.tournamentId, req.params.campaignId, principal.id, String(res.locals.requestId), parsed.data);
  res.json({ data: { campaign }, meta: { requestId: res.locals.requestId } });
}));

sponsorRouter.post("/:tenantId/tournaments/:tournamentId/sponsor-campaigns/:campaignId/state", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = campaignActionSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Campaign state change is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const campaign = await changeCampaignState(req.params.tenantId, req.params.tournamentId, req.params.campaignId, principal.id, String(res.locals.requestId), parsed.data);
  res.json({ data: { campaign }, meta: { requestId: res.locals.requestId } });
}));

export const publicSponsorRouter = Router();
const publicSponsorReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many public sponsor reads. Try again later.", requestId: res.locals.requestId } }),
});

publicSponsorRouter.get("/:tournamentId/sponsors", publicSponsorReadLimiter, asyncHandler(async (req, res) => {
  const parsed = publicSponsorQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Public sponsor query is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const result = await listPublicSponsorPlacements(req.params.tournamentId, parsed.data.placement);
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: result, meta: { requestId: res.locals.requestId, count: result.placements.length } });
}));

publicSponsorRouter.get("/:tournamentId/sponsors/:campaignId/creative", publicSponsorReadLimiter, asyncHandler(async (req, res) => {
  const content = await getPublicSponsorCreative(req.params.tournamentId, req.params.campaignId);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Content-Type", content.contentType);
  res.setHeader("Content-Length", String(content.bytes.length));
  res.setHeader("Content-Disposition", "inline");
  res.status(200).send(content.bytes);
}));

publicSponsorRouter.get("/:tournamentId/sponsors/:campaignId/logo", publicSponsorReadLimiter, asyncHandler(async (req, res) => {
  const content = await getPublicSponsorLogo(req.params.tournamentId, req.params.campaignId);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Content-Type", content.contentType);
  res.setHeader("Content-Length", String(content.bytes.length));
  res.setHeader("Content-Disposition", "inline");
  res.status(200).send(content.bytes);
}));
