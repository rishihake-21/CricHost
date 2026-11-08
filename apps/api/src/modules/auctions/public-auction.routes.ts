import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { publicAuctionCatalogueQuerySchema, publicAuctionResultsQuerySchema } from "./auction.schemas.js";
import { getPublicAuctionSnapshot, listPublicAuctionResults } from "./auction-read.service.js";

export const publicAuctionRouter = Router();
const publicReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many public auction reads. Try again later.", requestId: res.locals.requestId } }),
});

publicAuctionRouter.get("/:tournamentId/auction", publicReadLimiter, asyncHandler(async (req, res) => {
  const parsed = publicAuctionCatalogueQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Public auction snapshot query is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const snapshot = await getPublicAuctionSnapshot(req.params.tournamentId, parsed.data.limit, parsed.data.afterLotNumber);
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: snapshot, meta: { requestId: res.locals.requestId } });
}));

publicAuctionRouter.get("/:tournamentId/auction/results", publicReadLimiter, asyncHandler(async (req, res) => {
  const parsed = publicAuctionResultsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Public auction results query is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const page = await listPublicAuctionResults(req.params.tournamentId, parsed.data.limit, parsed.data.beforeId);
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: page, meta: { requestId: res.locals.requestId, count: page.results.length } });
}));
