import "dotenv/config";
import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import mongoose, { Types } from "mongoose";
import { createClient } from "redis";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REALTIME_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  REALTIME_MAX_STREAMS: z.coerce.number().int().min(1).max(100_000).default(2000),
  REALTIME_MAX_STREAMS_PER_IP: z.coerce.number().int().min(1).max(100).default(10),
  API_PUBLIC_BASE_URL: z.string().url().default("http://localhost:4000"),
  WEB_ORIGINS: z.string().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
});
const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) throw new Error(`Invalid realtime configuration: ${parsedEnv.error.issues.map((issue) => issue.path.join(".")).join(", ")}`);
const env = {
  ...parsedEnv.data,
  webOrigins: (parsedEnv.data.WEB_ORIGINS ?? "http://localhost:5173").split(",").map((origin) => origin.trim()).filter(Boolean),
};

const redisChannel = "crichost:domain-events:v1";
const snapshotUrl = (resourceType: "auction" | "match", tournamentId: string, resourceId: string) => new URL(`/public/v1/tournaments/${tournamentId}/${resourceType === "auction" ? "auction" : `matches/${resourceId}`}`, env.API_PUBLIC_BASE_URL).toString();
const publicAuctionStates = ["SCHEDULED", "LIVE", "PAUSED", "COMPLETED", "ARCHIVED"];
const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
const dateTimeSchema = z.string().datetime({ offset: true });
const publicEventDataSchemas: Record<string, z.ZodTypeAny> = {
  "auction.scheduled": z.object({ auctionId: idSchema, tournamentId: idSchema, scheduledAt: dateTimeSchema, status: z.literal("SCHEDULED") }).passthrough(),
  "auction.started": z.object({ auctionId: idSchema, tournamentId: idSchema, startedAt: dateTimeSchema, status: z.literal("LIVE") }).passthrough(),
  "auction.paused": z.object({ auctionId: idSchema, tournamentId: idSchema, status: z.literal("PAUSED"), pausedAt: dateTimeSchema, currentLotId: idSchema.nullable() }).passthrough(),
  "auction.resumed": z.object({ auctionId: idSchema, tournamentId: idSchema, status: z.literal("LIVE"), resumedAt: dateTimeSchema, currentLotId: idSchema.nullable() }).passthrough(),
  "auction.lot.opened": z.object({ auctionId: idSchema, tournamentId: idSchema, lotId: idSchema, lotNumber: z.number().int().positive(), attemptNumber: z.number().int().positive(), closesAt: dateTimeSchema }).passthrough(),
  "auction.lot.reoffered": z.object({ auctionId: idSchema, tournamentId: idSchema, lotId: idSchema, lotNumber: z.number().int().positive(), attemptNumber: z.number().int().positive() }).passthrough(),
  "auction.bid.accepted": z.object({ auctionId: idSchema, tournamentId: idSchema, lotId: idSchema, lotNumber: z.number().int().positive(), sequence: z.number().int().positive(), teamId: idSchema, amount: z.number().int().positive(), closesAt: dateTimeSchema }).passthrough(),
  "auction.lot.sold": z.object({ auctionId: idSchema, tournamentId: idSchema, lotId: idSchema, lotNumber: z.number().int().positive(), attemptNumber: z.number().int().positive(), outcome: z.literal("SOLD"), winnerTeamId: idSchema, finalPrice: z.number().int().positive(), resultId: idSchema }).passthrough(),
  "auction.lot.unsold": z.object({ auctionId: idSchema, tournamentId: idSchema, lotId: idSchema, lotNumber: z.number().int().positive(), attemptNumber: z.number().int().positive(), outcome: z.literal("UNSOLD"), winnerTeamId: z.null(), finalPrice: z.literal(0), resultId: idSchema }).passthrough(),
  "auction.completed": z.object({ auctionId: idSchema, tournamentId: idSchema, status: z.literal("COMPLETED") }).passthrough(),
  "match.snapshot.changed": z.object({ matchId: idSchema, tournamentId: idSchema }).passthrough(),
};
const eventTypes = Object.keys(publicEventDataSchemas);
const publicEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(80),
  eventType: z.enum(eventTypes as [string, ...string[]]),
  schemaVersion: z.number().int().positive(),
  aggregateType: z.string().min(1).max(80),
  aggregateId: z.string().min(1).max(160),
  aggregateVersion: z.number().int().positive(),
  visibility: z.literal("PUBLIC"),
  occurredAt: dateTimeSchema,
  data: z.record(z.string(), z.unknown()),
});

type RealtimeEnvelope = z.infer<typeof publicEnvelopeSchema>;
type StreamClient = { response: Response; tournamentId: string; auctionId?: string; matchId?: string; ip: string };
const clientsByAuction = new Map<string, Set<StreamClient>>();
const clientsByMatch = new Map<string, Set<StreamClient>>();
const streamCountByIp = new Map<string, number>();
let activeStreamCount = 0;
let redisReady = false;

function projectedData(eventType: string, rawData: Record<string, unknown>): Record<string, unknown> | null {
  const parsed = publicEventDataSchemas[eventType]?.safeParse(rawData);
  if (!parsed?.success) return null;
  const data = parsed.data as Record<string, unknown>;
  const keysByType: Record<string, string[]> = {
    "auction.scheduled": ["auctionId", "tournamentId", "scheduledAt", "status"],
    "auction.started": ["auctionId", "tournamentId", "startedAt", "status"],
    "auction.paused": ["auctionId", "tournamentId", "status", "pausedAt", "currentLotId"],
    "auction.resumed": ["auctionId", "tournamentId", "status", "resumedAt", "currentLotId"],
    "auction.lot.opened": ["auctionId", "tournamentId", "lotId", "lotNumber", "attemptNumber", "closesAt"],
    "auction.lot.reoffered": ["auctionId", "tournamentId", "lotId", "lotNumber", "attemptNumber"],
    "auction.bid.accepted": ["auctionId", "tournamentId", "lotId", "lotNumber", "sequence", "teamId", "amount", "closesAt"],
    "auction.lot.sold": ["auctionId", "tournamentId", "lotId", "lotNumber", "attemptNumber", "outcome", "winnerTeamId", "finalPrice", "resultId"],
    "auction.lot.unsold": ["auctionId", "tournamentId", "lotId", "lotNumber", "attemptNumber", "outcome", "winnerTeamId", "finalPrice", "resultId"],
    "auction.completed": ["auctionId", "tournamentId", "status"],
    "match.snapshot.changed": ["matchId", "tournamentId"],
  };
  return Object.fromEntries((keysByType[eventType] ?? []).map((key) => [key, data[key]] as const));
}

function writeEvent(client: StreamClient, eventName: string, data: Record<string, unknown>, eventId?: string): void {
  if (client.response.writableEnded || client.response.destroyed) return;
  if (client.response.writableLength > 64 * 1024) {
    client.response.end();
    return;
  }
  const idLine = eventId ? `id: ${eventId}\n` : "";
  client.response.write(`${idLine}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}

function disconnectClient(client: StreamClient): void {
  if (client.auctionId) {
    const clients = clientsByAuction.get(client.auctionId);
    clients?.delete(client);
    if (clients?.size === 0) clientsByAuction.delete(client.auctionId);
  }
  if (client.matchId) {
    const clients = clientsByMatch.get(client.matchId);
    clients?.delete(client);
    if (clients?.size === 0) clientsByMatch.delete(client.matchId);
  }
  activeStreamCount = Math.max(0, activeStreamCount - 1);
  const remainingForIp = Math.max(0, (streamCountByIp.get(client.ip) ?? 1) - 1);
  if (remainingForIp === 0) streamCountByIp.delete(client.ip);
  else streamCountByIp.set(client.ip, remainingForIp);
}

function snapshotRequiredData(client: StreamClient, reason: string) {
  const resourceType = client.auctionId ? "auction" as const : "match" as const;
  const resourceId = client.auctionId ?? client.matchId ?? "";
  return {
    ...(client.auctionId ? { auctionId: client.auctionId } : { matchId: client.matchId }),
    tournamentId: client.tournamentId,
    reason,
    snapshotUrl: snapshotUrl(resourceType, client.tournamentId, resourceId),
  };
}

async function dispatchPublicEvent(rawMessage: string): Promise<void> {
  let raw: unknown;
  try { raw = JSON.parse(rawMessage); } catch { return; }
  const parsed = publicEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return;
  const event: RealtimeEnvelope = parsed.data;
  const safeData = projectedData(event.eventType, event.data);
  if (!safeData || typeof safeData.tournamentId !== "string") return;
  const auctionId = typeof safeData.auctionId === "string" ? safeData.auctionId : undefined;
  const matchId = typeof safeData.matchId === "string" ? safeData.matchId : undefined;
  if (!auctionId && !matchId) return;
  const clients = auctionId ? clientsByAuction.get(auctionId) : clientsByMatch.get(matchId!);
  if (!clients) return;
  const matchingClients = [...clients].filter((client) => client.tournamentId === safeData.tournamentId);
  if (matchingClients.length === 0) return;

  // Recheck current public visibility at delivery time so an old outbox event
  // cannot disclose data after a tournament has been made private.
  const database = mongoose.connection.db;
  if (!database) {
    for (const client of matchingClients) {
      writeEvent(client, "snapshot_required", snapshotRequiredData(client, "visibility_unavailable"));
      client.response.end();
    }
    return;
  }
  try {
    const tournamentIsPublic = await database.collection("tournaments").findOne(
      { _id: new Types.ObjectId(safeData.tournamentId), visibility: "PUBLIC" },
      { projection: { _id: 1, tenantId: 1 } },
    );
    if (!tournamentIsPublic) {
      for (const client of matchingClients) {
        writeEvent(client, "snapshot_required", snapshotRequiredData(client, "tournament_no_longer_public"));
        client.response.end();
      }
      return;
    }
    if (matchId) {
      const matchIsPublic = await database.collection("matches").findOne(
        { _id: new Types.ObjectId(matchId), tournamentId: new Types.ObjectId(safeData.tournamentId), tenantId: tournamentIsPublic.tenantId },
        { projection: { _id: 1 } },
      );
      if (!matchIsPublic) {
        for (const client of matchingClients) {
          writeEvent(client, "snapshot_required", snapshotRequiredData(client, "match_unavailable"));
          client.response.end();
        }
        return;
      }
    }
  } catch {
    for (const client of matchingClients) {
      writeEvent(client, "snapshot_required", snapshotRequiredData(client, "visibility_unavailable"));
      client.response.end();
    }
    return;
  }
  const envelope = {
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    occurredAt: event.occurredAt,
    data: safeData,
  };
  for (const client of matchingClients) writeEvent(client, event.eventType, envelope, event.eventId);
}

function notifySnapshotRequired(reason: string): void {
  for (const clients of [...clientsByAuction.values(), ...clientsByMatch.values()]) {
    for (const client of clients) writeEvent(client, "snapshot_required", snapshotRequiredData(client, reason));
  }
}

function createApp(subscriber: ReturnType<typeof createClient>) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY_HOPS);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: env.webOrigins, credentials: false, methods: ["GET", "OPTIONS"] }));
  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", (_req, res) => {
    const databaseReady = mongoose.connection.readyState === 1;
    const ready = databaseReady && redisReady && subscriber.isReady;
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", dependencies: { database: databaseReady ? "ready" : "unavailable", redis: redisReady && subscriber.isReady ? "ready" : "unavailable" } });
  });

  const streamLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many stream connections. Try again later." } }),
  });

  app.get("/public/v1/tournaments/:tournamentId/auction/events", streamLimiter, async (req, res) => {
    const tournamentId = req.params.tournamentId;
    if (!Types.ObjectId.isValid(tournamentId) || !/^[a-f\d]{24}$/i.test(tournamentId)) {
      res.status(404).json({ error: { code: "PUBLIC_AUCTION_NOT_FOUND", message: "Public auction was not found" } });
      return;
    }
    if (!redisReady || !subscriber.isReady) {
      res.status(503).json({ error: { code: "REALTIME_UNAVAILABLE", message: "Public auction updates are temporarily unavailable" } });
      return;
    }
    if (activeStreamCount >= env.REALTIME_MAX_STREAMS) {
      res.status(503).json({ error: { code: "STREAM_CAPACITY_REACHED", message: "Public auction stream capacity is temporarily full" } });
      return;
    }
    const ip = req.ip || "unknown";
    if ((streamCountByIp.get(ip) ?? 0) >= env.REALTIME_MAX_STREAMS_PER_IP) {
      res.status(429).json({ error: { code: "STREAM_LIMIT_REACHED", message: "Too many active streams from this address" } });
      return;
    }

    try {
      const database = mongoose.connection.db;
      if (!database) throw new Error("DATABASE_UNAVAILABLE");
      const objectId = new Types.ObjectId(tournamentId);
      const tournament = await database.collection("tournaments").findOne({ _id: objectId, visibility: "PUBLIC" }, { projection: { _id: 1, tenantId: 1 } });
      if (!tournament) {
        res.status(404).json({ error: { code: "PUBLIC_AUCTION_NOT_FOUND", message: "Public auction was not found" } });
        return;
      }
      const auction = await database.collection("auctions").findOne({
        tenantId: tournament.tenantId,
        tournamentId: objectId,
        status: { $in: publicAuctionStates },
      }, { projection: { _id: 1 } });
      if (!auction) {
        res.status(404).json({ error: { code: "PUBLIC_AUCTION_NOT_FOUND", message: "Public auction was not found" } });
        return;
      }

      const client: StreamClient = { response: res, tournamentId, auctionId: auction._id.toString(), ip };
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("X-Request-Id", randomUUID());
      const clients = clientsByAuction.get(client.auctionId!) ?? new Set<StreamClient>();
      clients.add(client);
      clientsByAuction.set(client.auctionId!, clients);
      activeStreamCount += 1;
      streamCountByIp.set(ip, (streamCountByIp.get(ip) ?? 0) + 1);
      res.once("close", () => disconnectClient(client));
      res.flushHeaders();
      res.write("retry: 5000\n\n");
      writeEvent(client, "snapshot_required", snapshotRequiredData(client, "connected"));
    } catch {
      if (!res.headersSent) res.status(503).json({ error: { code: "REALTIME_UNAVAILABLE", message: "Public auction updates are temporarily unavailable" } });
      else res.end();
    }
  });

  app.get("/public/v1/tournaments/:tournamentId/matches/:matchId/events", streamLimiter, async (req, res) => {
    const { tournamentId, matchId } = req.params;
    if (!Types.ObjectId.isValid(tournamentId) || !/^[a-f\d]{24}$/i.test(tournamentId) || !Types.ObjectId.isValid(matchId) || !/^[a-f\d]{24}$/i.test(matchId)) {
      res.status(404).json({ error: { code: "PUBLIC_MATCH_NOT_FOUND", message: "Public match was not found" } });
      return;
    }
    if (!redisReady || !subscriber.isReady) {
      res.status(503).json({ error: { code: "REALTIME_UNAVAILABLE", message: "Public match updates are temporarily unavailable" } });
      return;
    }
    if (activeStreamCount >= env.REALTIME_MAX_STREAMS) {
      res.status(503).json({ error: { code: "STREAM_CAPACITY_REACHED", message: "Public stream capacity is temporarily full" } });
      return;
    }
    const ip = req.ip || "unknown";
    if ((streamCountByIp.get(ip) ?? 0) >= env.REALTIME_MAX_STREAMS_PER_IP) {
      res.status(429).json({ error: { code: "STREAM_LIMIT_REACHED", message: "Too many active streams from this address" } });
      return;
    }
    try {
      const database = mongoose.connection.db;
      if (!database) throw new Error("DATABASE_UNAVAILABLE");
      const tournamentObjectId = new Types.ObjectId(tournamentId);
      const matchObjectId = new Types.ObjectId(matchId);
      const tournament = await database.collection("tournaments").findOne({ _id: tournamentObjectId, visibility: "PUBLIC" }, { projection: { _id: 1, tenantId: 1 } });
      if (!tournament) {
        res.status(404).json({ error: { code: "PUBLIC_MATCH_NOT_FOUND", message: "Public match was not found" } });
        return;
      }
      const match = await database.collection("matches").findOne({ _id: matchObjectId, tournamentId: tournamentObjectId, tenantId: tournament.tenantId }, { projection: { _id: 1 } });
      if (!match) {
        res.status(404).json({ error: { code: "PUBLIC_MATCH_NOT_FOUND", message: "Public match was not found" } });
        return;
      }
      const client: StreamClient = { response: res, tournamentId, matchId, ip };
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("X-Request-Id", randomUUID());
      const clients = clientsByMatch.get(matchId) ?? new Set<StreamClient>();
      clients.add(client);
      clientsByMatch.set(matchId, clients);
      activeStreamCount += 1;
      streamCountByIp.set(ip, (streamCountByIp.get(ip) ?? 0) + 1);
      res.once("close", () => disconnectClient(client));
      res.flushHeaders();
      res.write("retry: 5000\n\n");
      writeEvent(client, "snapshot_required", snapshotRequiredData(client, "connected"));
    } catch {
      if (!res.headersSent) res.status(503).json({ error: { code: "REALTIME_UNAVAILABLE", message: "Public match updates are temporarily unavailable" } });
      else res.end();
    }
  });

  app.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Resource was not found" } }));
  return app;
}

async function run(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 20, minPoolSize: 1, autoIndex: env.NODE_ENV !== "production" });
  const subscriber = createClient({ url: env.REDIS_URL });
  subscriber.on("error", () => {
    redisReady = false;
    notifySnapshotRequired("redis_unavailable");
    console.error(JSON.stringify({ event: "realtime_redis_error" }));
  });
  subscriber.on("reconnecting", () => {
    redisReady = false;
    notifySnapshotRequired("redis_reconnecting");
  });
  subscriber.on("ready", () => {
    redisReady = true;
    notifySnapshotRequired("redis_reconnected");
  });
  await subscriber.connect();
  await subscriber.subscribe(redisChannel, dispatchPublicEvent);
  redisReady = subscriber.isReady;

  const app = createApp(subscriber);
  const server = app.listen(env.REALTIME_PORT, () => console.info(JSON.stringify({ event: "realtime_gateway_started", port: env.REALTIME_PORT, channel: redisChannel })));
  const heartbeat = setInterval(() => {
    for (const clients of [...clientsByAuction.values(), ...clientsByMatch.values()]) {
      for (const client of clients) {
        if (client.response.writableLength > 64 * 1024) client.response.end();
        else client.response.write(": keepalive\n\n");
      }
    }
  }, 15_000);
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(JSON.stringify({ event: "realtime_gateway_shutdown_started", signal }));
    clearInterval(heartbeat);
    notifySnapshotRequired("gateway_shutdown");
    for (const clients of [...clientsByAuction.values(), ...clientsByMatch.values()]) {
      for (const client of clients) client.response.end();
    }
    server.close(() => {
      void subscriber.quit().catch(() => undefined).finally(() => void mongoose.disconnect());
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void run().catch(async (error: unknown) => {
  console.error(JSON.stringify({ event: "realtime_gateway_startup_failed", code: error instanceof Error ? error.name : "UNKNOWN" }));
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
