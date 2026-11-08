import type { ClientSession } from "mongoose";
import { z } from "zod";
import { AuditEntry } from "./models/audit-entry.model.js";

const auditInputSchema = z.object({
  tenantId: z.string().optional(),
  actorType: z.enum(["USER", "SYSTEM"]),
  actorId: z.string().optional(),
  action: z.string().min(1).max(120),
  outcome: z.enum(["SUCCEEDED", "DENIED", "FAILED"]),
  resourceType: z.string().min(1).max(80),
  resourceId: z.string().min(1).max(160),
  requestId: z.string().max(80).optional(),
  reason: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const sensitiveKey = /(password|token|secret|authorization|cookie|email|phone|address|birth|dob|document|contact)/i;
function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 2) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 256);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveKey.test(key))
      .slice(0, 20)
      .map(([key, item]) => [key.slice(0, 80), safeValue(item, depth + 1)]));
  }
  return String(value).slice(0, 80);
}

export type AuditInput = z.infer<typeof auditInputSchema>;

export async function recordAudit(input: AuditInput, session?: ClientSession): Promise<void> {
  const parsed = auditInputSchema.parse(input);
  const entry = {
    ...parsed,
    ...(parsed.metadata ? { metadata: safeValue(parsed.metadata) } : {}),
  };
  if (session) await AuditEntry.create([entry], { session });
  else await AuditEntry.create(entry);
}
