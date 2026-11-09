import { z } from "zod";
import "dotenv/config";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  REDIS_URL: z.string().optional(),
  AUCTION_TIMER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(750),
  OUTBOX_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(12),
  WEB_ORIGINS: z.string().optional(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  SESSION_ACCESS_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
  SESSION_REFRESH_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),
  IDENTITY_EXPOSE_DEV_TOKENS: z.enum(["true", "false"]).default("false"),
  ASSET_STORAGE_DIR: z.string().trim().min(1).default("./var/assets"),
  ASSET_UPLOAD_SIGNING_SECRET: z.string().min(32).optional(),
  ASSET_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(25 * 1024 * 1024).default(5 * 1024 * 1024),
  ASSET_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  ASSET_CLAMAV_HOST: z.preprocess((value) => typeof value === "string" && value.trim() === "" ? undefined : value, z.string().trim().min(1).optional()),
  ASSET_CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map(({ path, message }) => `${path.join(".")}: ${message}`);
  throw new Error(`Invalid environment configuration: ${issues.join("; ")}`);
}

if (parsed.data.NODE_ENV === "production" && !parsed.data.WEB_ORIGINS?.trim()) {
  throw new Error("WEB_ORIGINS must be explicitly configured in production");
}

if (parsed.data.ASSET_UPLOAD_SIGNING_SECRET && parsed.data.ASSET_UPLOAD_SIGNING_SECRET.length < 32) {
  throw new Error("ASSET_UPLOAD_SIGNING_SECRET must contain at least 32 characters");
}
if (parsed.data.NODE_ENV === "production" && (!parsed.data.ASSET_UPLOAD_SIGNING_SECRET || parsed.data.ASSET_UPLOAD_SIGNING_SECRET === "replace-with-at-least-32-random-characters")) {
  throw new Error("A unique ASSET_UPLOAD_SIGNING_SECRET must be configured in production");
}

export const env = {
  ...parsed.data,
  webOrigins: (parsed.data.WEB_ORIGINS ?? "http://localhost:5173").split(",").map((origin) => origin.trim()).filter(Boolean),
  exposeDevTokens: parsed.data.NODE_ENV !== "production" && parsed.data.IDENTITY_EXPOSE_DEV_TOKENS === "true",
};
