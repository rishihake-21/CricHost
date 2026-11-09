import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./platform/config/env.js";
import { connectDatabase, databaseReady, disconnectDatabase } from "./platform/db/mongoose.js";
import { requestContext } from "./platform/http/request-context.js";
import { originGuard } from "./platform/http/origin-guard.js";
import { errorHandler } from "./platform/http/error-handler.js";
import { notFound } from "./platform/http/not-found.js";
import { identityRouter } from "./modules/identity/identity.routes.js";
import { tenantRouter } from "./modules/tenants/tenant.routes.js";
import { tournamentRouter } from "./modules/tournaments/tournament.routes.js";
import { playerRouter } from "./modules/players/player.routes.js";
import { registrationRouter } from "./modules/registrations/registration.routes.js";
import { teamRouter } from "./modules/teams/team.routes.js";
import { fixtureRouter } from "./modules/fixtures/fixture.routes.js";
import { auctionRouter } from "./modules/auctions/auction.routes.js";
import { publicAuctionRouter } from "./modules/auctions/public-auction.routes.js";
import { matchRouter } from "./modules/matches/match.routes.js";
import { publicMatchRouter } from "./modules/matches/public-match.routes.js";
import { assetRouter } from "./modules/assets/asset.routes.js";
import { publicSponsorRouter, sponsorRouter } from "./modules/sponsors/sponsor.routes.js";
import { subscriptionRouter } from "./modules/subscriptions/subscription.routes.js";
import { usageRouter } from "./modules/usage/usage.routes.js";
import { platformAdminRouter } from "./modules/platform-admin/platform-admin.routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY_HOPS);
  app.use(requestContext);
  app.use(helmet());
  app.use(cors({ origin: env.webOrigins, credentials: true, allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "X-Asset-Upload-Token"], methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] }));
  app.use(originGuard);
  app.use(express.json({ limit: "1mb", type: "application/json" }));

  app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
  app.get("/health/ready", (_req, res) => {
    const ready = databaseReady();
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", dependencies: { database: ready ? "ready" : "unavailable" } });
  });
  app.get("/v1", (_req, res) => res.json({ data: { service: "crichost-api", version: "v1" }, meta: { requestId: res.locals.requestId } }));
  app.use("/v1/auth", identityRouter);
  app.use("/v1/platform-admin", platformAdminRouter);
  app.use("/v1/tenants", tenantRouter);
  app.use("/v1/tenants", tournamentRouter);
  app.use("/v1/tenants", registrationRouter);
  app.use("/v1/tenants", teamRouter);
  app.use("/v1/tenants", fixtureRouter);
  app.use("/v1/tenants", auctionRouter);
  app.use("/v1/tenants", matchRouter);
  app.use("/v1/tenants", assetRouter);
  app.use("/v1/tenants", sponsorRouter);
  app.use("/v1/tenants", subscriptionRouter);
  app.use("/v1/tenants", usageRouter);
  app.use("/public/v1/tournaments", publicAuctionRouter);
  app.use("/public/v1/tournaments", publicMatchRouter);
  app.use("/public/v1/tournaments", publicSponsorRouter);
  app.use("/v1/player-profiles", playerRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

async function start(): Promise<void> {
  await connectDatabase();
  const app = createApp();
  const server = app.listen(env.PORT, () => console.info(JSON.stringify({ event: "api_started", port: env.PORT, environment: env.NODE_ENV })));
  const shutdown = (signal: string) => {
    console.info(JSON.stringify({ event: "api_shutdown_started", signal }));
    server.close((error) => {
      void disconnectDatabase().finally(() => {
        if (error) { console.error(JSON.stringify({ event: "api_shutdown_error", message: error.message })); process.exitCode = 1; }
      });
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

void start().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "api_startup_failed", message: error instanceof Error ? error.message : "unknown" }));
  process.exitCode = 1;
});
