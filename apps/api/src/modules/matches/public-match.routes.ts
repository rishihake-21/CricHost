import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { getPublicMatchSnapshot, listPublicMatches } from "./public-match.service.js";

export const publicMatchRouter = Router();
const publicMatchReadQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  afterFixtureNumber: z.coerce.number().int().nonnegative().default(0),
}).strict();
const publicReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many public match reads. Try again later.", requestId: res.locals.requestId } }),
});

publicMatchRouter.get("/:tournamentId/matches", publicReadLimiter, asyncHandler(async (req, res) => {
  const parsed = publicMatchReadQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Public match list query is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const result = await listPublicMatches(req.params.tournamentId, parsed.data.limit, parsed.data.afterFixtureNumber);
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: result, meta: { requestId: res.locals.requestId, count: result.matches.length } });
}));

publicMatchRouter.get("/:tournamentId/matches/:matchId", publicReadLimiter, asyncHandler(async (req, res) => {
  const result = await getPublicMatchSnapshot(req.params.tournamentId, req.params.matchId);
  res.setHeader("Cache-Control", "no-store");
  res.json({ data: result, meta: { requestId: res.locals.requestId } });
}));
