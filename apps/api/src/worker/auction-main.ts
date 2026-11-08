import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { env } from "../platform/config/env.js";
import { connectDatabase, disconnectDatabase } from "../platform/db/mongoose.js";
import { AppError } from "../platform/errors/app-error.js";
import { Auction } from "../modules/auctions/models/auction.model.js";
import { AuctionLot } from "../modules/auctions/models/auction-lot.model.js";
import { finalizeAuctionLot, openNextAuctionLot, type AuctionActor } from "../modules/auctions/auction-live.service.js";

const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`.slice(0, 120);
const systemActor: AuctionActor = { type: "SYSTEM" };
const batchSize = 100;
const errorLogCooldownMs = 30_000;
const lastErrorLoggedAt = new Map<string, number>();
let stopping = false;
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function errorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) return String(error.code);
  return error instanceof Error ? error.name : "UNKNOWN";
}

function logFailure(key: string, event: string, error: unknown, context: Record<string, string>): void {
  const now = Date.now();
  if (now - (lastErrorLoggedAt.get(key) ?? 0) < errorLogCooldownMs) return;
  lastErrorLoggedAt.set(key, now);
  if (lastErrorLoggedAt.size > 1000) {
    for (const [entry, loggedAt] of lastErrorLoggedAt) if (now - loggedAt > errorLogCooldownMs * 4) lastErrorLoggedAt.delete(entry);
  }
  console.error(JSON.stringify({ event, workerId, code: errorCode(error), ...context }));
}

async function openNextIfReady(tenantId: string, auctionId: string): Promise<void> {
  const auction = await Auction.findOne({ _id: auctionId, tenantId, status: "LIVE", currentLotId: null })
    .select("aggregateVersion")
    .lean();
  if (!auction) return;
  const advanced = await openNextAuctionLot(
    tenantId,
    auctionId,
    systemActor,
    `auction-worker:advance:${auctionId}:${auction.aggregateVersion}`,
    auction.aggregateVersion,
  );
  if (!advanced.idempotentReplay) {
    console.info(JSON.stringify({ event: advanced.lot ? "auction_timer_lot_opened" : "auction_timer_completed", workerId, auctionId, lotId: advanced.lot?.id ?? null }));
  }
}

async function advanceAuctionsWithoutOpenLots(): Promise<void> {
  const auctions = await Auction.find({ status: "LIVE", currentLotId: null })
    .select("_id tenantId aggregateVersion")
    .sort({ updatedAt: 1, _id: 1 })
    .limit(batchSize)
    .lean();
  for (const auction of auctions) {
    try {
      const advanced = await openNextAuctionLot(
        auction.tenantId.toString(),
        auction._id.toString(),
        systemActor,
        `auction-worker:advance:${auction._id.toString()}:${auction.aggregateVersion}`,
        auction.aggregateVersion,
      );
      if (!advanced.idempotentReplay) {
        console.info(JSON.stringify({ event: advanced.lot ? "auction_timer_lot_opened" : "auction_timer_completed", workerId, auctionId: auction._id.toString(), lotId: advanced.lot?.id ?? null }));
      }
    } catch (error) {
      if (["AUCTION_NOT_FOUND", "STALE_AUCTION_VERSION"].includes(errorCode(error))) continue;
      logFailure(`advance:${auction._id.toString()}`, "auction_timer_advance_failed", error, { auctionId: auction._id.toString() });
    }
  }
}

async function finalizeExpiredLots(): Promise<void> {
  const now = new Date();
  const expiredLots = await AuctionLot.find({ status: "OPEN", closesAt: { $lte: now } })
    .select("_id tenantId auctionId aggregateVersion")
    .sort({ closesAt: 1, _id: 1 })
    .limit(batchSize)
    .lean();

  for (const lot of expiredLots) {
    const tenantId = lot.tenantId.toString();
    const auctionId = lot.auctionId.toString();
    const lotId = lot._id.toString();
    try {
      const settlement = await finalizeAuctionLot(
        tenantId,
        auctionId,
        lotId,
        systemActor,
        `auction-worker:finalize:${lotId}:${lot.aggregateVersion}`,
        lot.aggregateVersion,
      );
      if (!settlement.idempotentReplay) {
        console.info(JSON.stringify({ event: "auction_timer_lot_finalized", workerId, auctionId, lotId, outcome: settlement.result.outcome }));
      }
      await openNextIfReady(tenantId, auctionId);
      lastErrorLoggedAt.delete(`finalize:${lotId}`);
    } catch (error) {
      const code = errorCode(error);
      if (["LOT_NOT_CURRENT", "LOT_TIMER_ACTIVE", "STALE_LOT_VERSION", "AUCTION_NOT_FOUND"].includes(code)) continue;
      logFailure(`finalize:${lotId}`, "auction_timer_finalization_failed", error, { auctionId, lotId });
    }
  }
}

async function run(): Promise<void> {
  await connectDatabase();
  console.info(JSON.stringify({ event: "auction_timer_worker_started", workerId, pollIntervalMs: env.AUCTION_TIMER_POLL_MS }));
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });

  try {
    while (!stopping) {
      try {
        await finalizeExpiredLots();
        await advanceAuctionsWithoutOpenLots();
      } catch (error) {
        logFailure("scan", "auction_timer_scan_failed", error, {});
      }
      if (!stopping) await wait(env.AUCTION_TIMER_POLL_MS);
    }
  } finally {
    await disconnectDatabase();
    console.info(JSON.stringify({ event: "auction_timer_worker_stopped", workerId }));
  }
}

void run().catch(async (error: unknown) => {
  console.error(JSON.stringify({ event: "auction_timer_worker_startup_failed", workerId, code: errorCode(error) }));
  await disconnectDatabase().catch(() => undefined);
  process.exitCode = 1;
});
