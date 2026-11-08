import express from "express";
import helmet from "helmet";
import cors from "cors";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const allowedOrigins = (process.env.WEB_ORIGIN ?? "http://localhost:5173").split(",").map((origin) => origin.trim());

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.get("/health/live", (_request, response) => response.json({ status: "ok" }));
app.get("/health/ready", (_request, response) => response.status(503).json({ status: "not_ready", reason: "database_not_configured" }));
app.get("/v1", (_request, response) => response.json({ data: { service: "crichost-api", version: "v1" } }));
app.listen(port, () => console.info(JSON.stringify({ event: "api_started", port })));
