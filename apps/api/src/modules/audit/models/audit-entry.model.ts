import { model, models, Schema } from "mongoose";

const auditEntrySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, default: null, index: true },
  actorType: { type: String, enum: ["USER", "SYSTEM"], required: true },
  actorId: { type: Schema.Types.ObjectId, default: null },
  action: { type: String, required: true, maxlength: 120 },
  outcome: { type: String, enum: ["SUCCEEDED", "DENIED", "FAILED"], required: true },
  resourceType: { type: String, required: true, maxlength: 80 },
  resourceId: { type: String, required: true, maxlength: 160 },
  requestId: { type: String, default: null, maxlength: 80 },
  reason: { type: String, default: null, maxlength: 500 },
  metadata: { type: Schema.Types.Mixed, default: {} },
  occurredAt: { type: Date, required: true, default: Date.now, immutable: true },
}, { versionKey: false, collection: "audit_logs", strict: "throw" });

auditEntrySchema.index({ tenantId: 1, occurredAt: -1 }, { name: "audit_tenant_time" });
auditEntrySchema.index({ resourceType: 1, resourceId: 1, occurredAt: -1 }, { name: "audit_resource_time" });
auditEntrySchema.index({ actorId: 1, occurredAt: -1 }, { name: "audit_actor_time" });

export const AuditEntry = models.AuditEntry ?? model("AuditEntry", auditEntrySchema);
