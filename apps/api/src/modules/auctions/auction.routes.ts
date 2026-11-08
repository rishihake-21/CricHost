import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { AppError } from "../../platform/errors/app-error.js";
import { requireIdentity } from "../identity/identity.middleware.js";
import { requireTenantMembership, requireVerifiedIdentity } from "../memberships/tenant-authorization.js";
import { getTournament } from "../tournaments/tournament.service.js";
import { assignAuctionBidderSchema, auctionBidHistoryQuerySchema, cancelAuctionSchema, createAuctionSchema, finalizeAuctionLotSchema, generateAuctionPoolSchema, openNextLotSchema, pauseAuctionSchema, placeAuctionBidSchema, removeAuctionBidderSchema, resumeAuctionSchema, scheduleAuctionSchema, startAuctionSchema } from "./auction.schemas.js";
import { approveAuctionPool, assignAuctionBidder, cancelDraftAuction, createAuction, getAuction, getTeamAuctionPurse, listAuctionBidders, listAuctionLots, listAuctionPurses, listAuctions, removeAuctionBidder } from "./auction.service.js";
import { finalizeAuctionLot, openNextAuctionLot, pauseAuction, placeAuctionBid, resumeAuction, scheduleAuction, startAuction } from "./auction-live.service.js";
import { listAuctionBidHistory } from "./auction-read.service.js";

export const auctionRouter = Router();
auctionRouter.use(requireIdentity, requireVerifiedIdentity);

auctionRouter.get("/:tenantId/tournaments/:tournamentId/auctions", requireTenantMembership(), asyncHandler(async (req, res) => {
  await getTournament(req.params.tenantId, req.params.tournamentId);
  const auctions = await listAuctions(req.params.tenantId, req.params.tournamentId);
  res.json({ data: { auctions }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/tournaments/:tournamentId/auctions", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = createAuctionSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Auction settings are invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const auction = await createAuction(req.params.tenantId, req.params.tournamentId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: { auction }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.get("/:tenantId/auctions/:auctionId", requireTenantMembership(), asyncHandler(async (req, res) => {
  const auction = await getAuction(req.params.tenantId, req.params.auctionId);
  res.json({ data: { auction }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/cancel", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = cancelAuctionSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Auction cancellation requires its current version and a reason", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const auction = await cancelDraftAuction(req.params.tenantId, req.params.auctionId, principal.id, String(res.locals.requestId), parsed.data.expectedAuctionVersion, parsed.data.reason);
  res.json({ data: { auction }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/teams/:teamId/bidders", requireTenantMembership(), asyncHandler(async (req, res) => {
  const parsed = assignAuctionBidderSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Auction bidder assignment is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const assignment = await assignAuctionBidder(req.params.tenantId, req.params.auctionId, req.params.teamId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: { assignment }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.get("/:tenantId/auctions/:auctionId/teams/:teamId/bidders", requireTenantMembership(), asyncHandler(async (req, res) => {
  const principal = res.locals.principal as { id: string };
  const bidders = await listAuctionBidders(req.params.tenantId, req.params.auctionId, req.params.teamId, principal.id);
  res.json({ data: { bidders }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/teams/:teamId/bidders/:userId/remove", requireTenantMembership(), asyncHandler(async (req, res) => {
  const parsed = removeAuctionBidderSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Provide a reason to remove this bidder", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const assignment = await removeAuctionBidder(req.params.tenantId, req.params.auctionId, req.params.teamId, req.params.userId, principal.id, String(res.locals.requestId), parsed.data.reason);
  res.json({ data: { assignment }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/pool/approve", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = generateAuctionPoolSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Auction pool generation details are invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const result = await approveAuctionPool(req.params.tenantId, req.params.auctionId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/schedule", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = scheduleAuctionSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Auction schedule is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const auction = await scheduleAuction(req.params.tenantId, req.params.auctionId, principal.id, String(res.locals.requestId), parsed.data.expectedAuctionVersion, parsed.data.scheduledAt);
  res.json({ data: { auction }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/start", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = startAuctionSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Auction start request is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const auction = await startAuction(req.params.tenantId, req.params.auctionId, principal.id, String(res.locals.requestId), parsed.data.expectedAuctionVersion);
  res.json({ data: { auction }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/pause", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = pauseAuctionSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Auction pause request is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const auction = await pauseAuction(req.params.tenantId, req.params.auctionId, principal.id, String(res.locals.requestId), parsed.data.expectedAuctionVersion, parsed.data.reason);
  res.json({ data: { auction }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/resume", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = resumeAuctionSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Auction resume request is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const auction = await resumeAuction(req.params.tenantId, req.params.auctionId, principal.id, String(res.locals.requestId), parsed.data.expectedAuctionVersion, parsed.data.reason);
  res.json({ data: { auction }, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/open-next-lot", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = openNextLotSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Lot opening request is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const result = await openNextAuctionLot(req.params.tenantId, req.params.auctionId, { type: "USER", id: principal.id }, String(res.locals.requestId), parsed.data.expectedAuctionVersion);
  res.json({ data: result, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/lots/:lotId/bids", requireTenantMembership(), asyncHandler(async (req, res) => {
  const parsed = placeAuctionBidSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Auction bid is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const result = await placeAuctionBid(req.params.tenantId, req.params.auctionId, req.params.lotId, principal.id, String(res.locals.requestId), parsed.data);
  res.status(result.idempotentReplay ? 200 : 201).json({ data: result, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.get("/:tenantId/auctions/:auctionId/lots/:lotId/bids", requireTenantMembership(), asyncHandler(async (req, res) => {
  const parsed = auctionBidHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Auction bid history query is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const page = await listAuctionBidHistory(req.params.tenantId, req.params.auctionId, req.params.lotId, parsed.data.limit, parsed.data.beforeSequence);
  res.json({ data: page, meta: { requestId: res.locals.requestId, count: page.bids.length } });
}));

auctionRouter.post("/:tenantId/auctions/:auctionId/lots/:lotId/finalize", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const parsed = finalizeAuctionLotSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "Lot finalization request is invalid", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) });
  const principal = res.locals.principal as { id: string };
  const result = await finalizeAuctionLot(req.params.tenantId, req.params.auctionId, req.params.lotId, { type: "USER", id: principal.id }, String(res.locals.requestId), parsed.data.expectedLotVersion);
  res.json({ data: result, meta: { requestId: res.locals.requestId } });
}));

auctionRouter.get("/:tenantId/auctions/:auctionId/lots", requireTenantMembership(), asyncHandler(async (req, res) => {
  await getAuction(req.params.tenantId, req.params.auctionId);
  const lots = await listAuctionLots(req.params.tenantId, req.params.auctionId);
  res.json({ data: { lots }, meta: { requestId: res.locals.requestId, count: lots.length } });
}));

auctionRouter.get("/:tenantId/auctions/:auctionId/purses", requireTenantMembership(["OWNER", "ADMIN"]), asyncHandler(async (req, res) => {
  const purses = await listAuctionPurses(req.params.tenantId, req.params.auctionId);
  res.json({ data: { purses }, meta: { requestId: res.locals.requestId, count: purses.length } });
}));

auctionRouter.get("/:tenantId/auctions/:auctionId/teams/:teamId/purse", requireTenantMembership(), asyncHandler(async (req, res) => {
  const principal = res.locals.principal as { id: string };
  const purse = await getTeamAuctionPurse(req.params.tenantId, req.params.auctionId, req.params.teamId, principal.id);
  res.json({ data: { purse }, meta: { requestId: res.locals.requestId } });
}));
