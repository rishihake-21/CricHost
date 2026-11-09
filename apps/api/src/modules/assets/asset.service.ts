import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { env } from "../../platform/config/env.js";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { Asset } from "./models/asset.model.js";
import type { CreateAssetUploadIntentInput } from "./asset.schemas.js";
import { assertAssetStorageQuota } from "../usage/usage.service.js";

const validId = (id: string) => Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);
const maxImagePixels = 40_000_000;
type UploadTokenPayload = { tenantId: string; assetId: string; expiresAt: number; nonce: string };

function signingSecret(): string {
  if (!env.ASSET_UPLOAD_SIGNING_SECRET || env.ASSET_UPLOAD_SIGNING_SECRET.length < 32) {
    throw new AppError(503, "ASSET_UPLOAD_UNAVAILABLE", "Asset uploads are not configured on this server");
  }
  return env.ASSET_UPLOAD_SIGNING_SECRET;
}

function sha256(value: Buffer | string): string { return createHash("sha256").update(value).digest("hex"); }
function signature(value: string): string { return createHmac("sha256", signingSecret()).update(value).digest("base64url"); }

function createUploadToken(payload: UploadTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(encoded)}`;
}

function verifyUploadToken(token: string): UploadTokenPayload {
  const [encoded, suppliedSignature, ...extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra.length > 0) throw new AppError(401, "ASSET_UPLOAD_TOKEN_INVALID", "Upload authorization is invalid or expired");
  const expected = Buffer.from(signature(encoded));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new AppError(401, "ASSET_UPLOAD_TOKEN_INVALID", "Upload authorization is invalid or expired");
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as UploadTokenPayload;
    if (!validId(payload.tenantId) || !validId(payload.assetId) || !Number.isInteger(payload.expiresAt) || typeof payload.nonce !== "string" || payload.nonce.length < 20 || payload.expiresAt * 1000 <= Date.now()) {
      throw new Error("invalid");
    }
    return payload;
  } catch {
    throw new AppError(401, "ASSET_UPLOAD_TOKEN_INVALID", "Upload authorization is invalid or expired");
  }
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 10_000 || height > 10_000 || width * height > maxImagePixels) {
    throw new AppError(400, "ASSET_DIMENSIONS_INVALID", "Image dimensions exceed the supported limits");
  }
}

function normalizePng(input: Buffer): { bytes: Buffer; width: number; height: number } {
  const signatureBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (input.length < 33 || !input.subarray(0, 8).equals(signatureBytes)) throw new AppError(400, "ASSET_SIGNATURE_INVALID", "Uploaded bytes are not a valid PNG image");
  const chunks: Buffer[] = [input.subarray(0, 8)];
  let offset = 8;
  let width = 0;
  let height = 0;
  let foundHeader = false;
  let foundEnd = false;
  while (offset + 12 <= input.length) {
    const chunkStart = offset;
    const length = input.readUInt32BE(offset);
    offset += 4;
    const type = input.toString("ascii", offset, offset + 4);
    offset += 4;
    const chunkEnd = offset + length + 4;
    if (!/^[A-Za-z]{4}$/.test(type) || chunkEnd > input.length) throw new AppError(400, "ASSET_IMAGE_INVALID", "PNG image structure is invalid");
    if (!foundHeader) {
      if (type !== "IHDR" || length !== 13) throw new AppError(400, "ASSET_IMAGE_INVALID", "PNG image header is invalid");
      width = input.readUInt32BE(offset);
      height = input.readUInt32BE(offset + 4);
      assertDimensions(width, height);
      foundHeader = true;
    } else if (type === "IHDR") {
      throw new AppError(400, "ASSET_IMAGE_INVALID", "PNG image contains multiple headers");
    }
    if (["eXIf", "tEXt", "zTXt", "iTXt", "iCCP", "tIME"].includes(type)) {
      // Remove EXIF, text, profile and timestamp chunks before the object is stored.
    } else {
      chunks.push(input.subarray(chunkStart, chunkEnd));
    }
    offset = chunkEnd;
    if (type === "IEND") {
      if (length !== 0 || offset !== input.length) throw new AppError(400, "ASSET_IMAGE_INVALID", "PNG image has invalid trailing data");
      foundEnd = true;
      break;
    }
  }
  if (!foundHeader || !foundEnd) throw new AppError(400, "ASSET_IMAGE_INVALID", "PNG image is incomplete");
  return { bytes: Buffer.concat(chunks), width, height };
}

function normalizeJpeg(input: Buffer): { bytes: Buffer; width: number; height: number } {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8 || input.at(-2) !== 0xff || input.at(-1) !== 0xd9) {
    throw new AppError(400, "ASSET_SIGNATURE_INVALID", "Uploaded bytes are not a complete JPEG image");
  }
  const chunks: Buffer[] = [input.subarray(0, 2)];
  const standaloneMarkers = new Set([0x01, 0xd8, 0xd9, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let width = 0;
  let height = 0;
  let foundFrame = false;
  let foundScan = false;
  while (offset < input.length) {
    const markerStart = offset;
    if (input[offset] !== 0xff) throw new AppError(400, "ASSET_IMAGE_INVALID", "JPEG marker structure is invalid");
    while (offset < input.length && input[offset] === 0xff) offset += 1;
    if (offset >= input.length) throw new AppError(400, "ASSET_IMAGE_INVALID", "JPEG marker structure is incomplete");
    const marker = input[offset]!;
    offset += 1;
    if (marker === 0xda) {
      if (offset + 2 > input.length) throw new AppError(400, "ASSET_IMAGE_INVALID", "JPEG scan header is incomplete");
      const scanHeaderLength = input.readUInt16BE(offset);
      const scanEnd = offset + scanHeaderLength;
      if (scanHeaderLength < 2 || scanEnd > input.length || !foundFrame) throw new AppError(400, "ASSET_IMAGE_INVALID", "JPEG scan header is invalid");
      chunks.push(input.subarray(markerStart));
      foundScan = true;
      break;
    }
    if (standaloneMarkers.has(marker)) {
      chunks.push(input.subarray(markerStart, offset));
      continue;
    }
    if (offset + 2 > input.length) throw new AppError(400, "ASSET_IMAGE_INVALID", "JPEG segment length is missing");
    const segmentLength = input.readUInt16BE(offset);
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || segmentEnd > input.length) throw new AppError(400, "ASSET_IMAGE_INVALID", "JPEG segment is invalid");
    if (frameMarkers.has(marker)) {
      if (segmentLength < 8) throw new AppError(400, "ASSET_IMAGE_INVALID", "JPEG frame header is invalid");
      height = input.readUInt16BE(offset + 3);
      width = input.readUInt16BE(offset + 5);
      assertDimensions(width, height);
      foundFrame = true;
    }
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata || marker === 0xe0) chunks.push(input.subarray(markerStart, segmentEnd));
    offset = segmentEnd;
  }
  if (!foundFrame || !foundScan) throw new AppError(400, "ASSET_IMAGE_INVALID", "JPEG image is incomplete");
  return { bytes: Buffer.concat(chunks), width, height };
}

function normalizeImage(contentType: string, input: Buffer) {
  if (contentType === "image/png") return { contentType, extension: "png", ...normalizePng(input) };
  if (contentType === "image/jpeg") return { contentType, extension: "jpg", ...normalizeJpeg(input) };
  throw new AppError(415, "ASSET_MEDIA_TYPE_UNSUPPORTED", "Only PNG and JPEG image uploads are accepted");
}

function objectPath(storageKey: string): string {
  const root = resolve(env.ASSET_STORAGE_DIR);
  const path = resolve(root, ...storageKey.split("/"));
  if (!path.startsWith(`${root}${sep}`)) throw new AppError(500, "ASSET_STORAGE_KEY_INVALID", "Stored asset path is invalid");
  return path;
}

async function writePrivateObject(storageKey: string, bytes: Buffer, claimToken: string): Promise<void> {
  const path = objectPath(storageKey);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${claimToken}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function assetDto(asset: {
  _id: Types.ObjectId; displayName: string; purpose: string; requestedContentType: string; contentType: string | null;
  expectedSizeBytes: number | null; sizeBytes: number | null; sha256: string | null; width: number | null; height: number | null;
  metadataStripped: boolean; status: string; scanStatus: string; reviewedAt: Date | null; reviewReason: string | null;
  aggregateVersion: number; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: asset._id.toString(), displayName: asset.displayName, purpose: asset.purpose,
    requestedContentType: asset.requestedContentType, contentType: asset.contentType,
    expectedSizeBytes: asset.expectedSizeBytes, sizeBytes: asset.sizeBytes,
    sha256: asset.sha256, width: asset.width, height: asset.height,
    metadataStripped: asset.metadataStripped, status: asset.status === "UPLOADING" ? "PENDING_UPLOAD" : asset.status, scanStatus: asset.scanStatus,
    reviewedAt: asset.reviewedAt, reviewReason: asset.reviewReason,
    version: asset.aggregateVersion, createdAt: asset.createdAt, updatedAt: asset.updatedAt,
  };
}

export async function createAssetUploadIntent(tenantId: string, actorId: string, requestId: string, input: CreateAssetUploadIntentInput) {
  if (!validId(tenantId)) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
  if (input.expectedSizeBytes !== undefined && input.expectedSizeBytes > env.ASSET_MAX_UPLOAD_BYTES) throw new AppError(400, "ASSET_SIZE_INVALID", "Expected size exceeds the configured upload limit");
  signingSecret();
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + env.ASSET_UPLOAD_TTL_SECONDS * 1000);
  return withTransaction(async (session: ClientSession) => {
    await assertAssetStorageQuota(tenantId, input.expectedSizeBytes ?? env.ASSET_MAX_UPLOAD_BYTES, session);
    const asset = new Asset({
      tenantId, createdById: actorId, displayName: input.displayName, purpose: input.purpose,
      requestedContentType: input.contentType, expectedSizeBytes: input.expectedSizeBytes ?? null,
      status: "PENDING_UPLOAD", scanStatus: "NOT_STARTED", uploadNonceHash: sha256(nonce), uploadExpiresAt: expiresAt,
    });
    await asset.save({ session });
    const uploadToken = createUploadToken({ tenantId, assetId: asset.id, expiresAt: Math.floor(expiresAt.getTime() / 1000), nonce });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "asset.upload_intent.created", outcome: "SUCCEEDED", resourceType: "asset", resourceId: asset.id, requestId, metadata: { purpose: asset.purpose, contentType: input.contentType, expectedSizeBytes: input.expectedSizeBytes ?? null } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "asset.upload_intent.created", schemaVersion: 1, aggregateType: "asset", aggregateId: asset.id, aggregateVersion: asset.aggregateVersion, visibility: "TENANT_PRIVATE", data: { assetId: asset.id, purpose: asset.purpose, status: asset.status, expiresAt } }, session);
    return {
      asset: assetDto(asset as unknown as Parameters<typeof assetDto>[0]),
      uploadUrl: `/v1/tenants/${tenantId}/assets/${asset.id}/content`,
      uploadToken,
      requiredHeaders: { "Content-Type": input.contentType, "X-Asset-Upload-Token": uploadToken },
      expiresAt,
      maxBytes: env.ASSET_MAX_UPLOAD_BYTES,
    };
  });
}

export async function receiveAssetUpload(tenantId: string, assetId: string, uploadToken: string, contentType: string, bytes: Buffer, requestId: string) {
  if (!validId(tenantId) || !validId(assetId)) throw new AppError(404, "ASSET_NOT_FOUND", "Asset was not found");
  const token = verifyUploadToken(uploadToken);
  if (token.tenantId !== tenantId || token.assetId !== assetId) throw new AppError(403, "ASSET_UPLOAD_TOKEN_SCOPE_INVALID", "Upload authorization does not match this asset");
  const asset = await Asset.findOne({ _id: assetId, tenantId }).select("+uploadNonceHash");
  if (!asset) throw new AppError(404, "ASSET_NOT_FOUND", "Asset was not found");
  if (!asset.uploadNonceHash || sha256(token.nonce) !== asset.uploadNonceHash) throw new AppError(401, "ASSET_UPLOAD_TOKEN_REVOKED", "Upload authorization is no longer valid");
  if (!asset.uploadExpiresAt || asset.uploadExpiresAt <= new Date()) throw new AppError(410, "ASSET_UPLOAD_EXPIRED", "Upload authorization has expired");
  if (asset.status !== "PENDING_UPLOAD" && asset.status !== "UPLOADING") throw new AppError(409, "ASSET_UPLOAD_ALREADY_USED", "This asset upload has already been completed");
  if (contentType.split(";")[0]?.trim().toLowerCase() !== asset.requestedContentType) throw new AppError(415, "ASSET_MEDIA_TYPE_MISMATCH", "Upload content type does not match the upload intent");
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > env.ASSET_MAX_UPLOAD_BYTES || (asset.expectedSizeBytes !== null && bytes.length !== asset.expectedSizeBytes)) {
    throw new AppError(413, "ASSET_SIZE_INVALID", "Uploaded image size does not match the permitted bounds");
  }
  const normalized = normalizeImage(asset.requestedContentType, bytes);
  if (normalized.bytes.length > env.ASSET_MAX_UPLOAD_BYTES) throw new AppError(413, "ASSET_SIZE_INVALID", "Normalized image exceeds the permitted size");
  const now = new Date();
  const claimToken = randomUUID();
  const claimed = await Asset.findOneAndUpdate({
    _id: assetId,
    tenantId,
    uploadNonceHash: sha256(token.nonce),
    uploadExpiresAt: { $gt: now },
    $or: [
      { status: "PENDING_UPLOAD" },
      { status: "UPLOADING", uploadClaimExpiresAt: { $lte: now } },
    ],
  }, {
    $set: { status: "UPLOADING", uploadClaimToken: claimToken, uploadClaimExpiresAt: new Date(now.getTime() + 5 * 60_000) },
  }, { new: true });
  if (!claimed) throw new AppError(409, "ASSET_UPLOAD_IN_PROGRESS", "This asset upload is already being processed or the intent expired");
  const storageKey = `${tenantId}/${assetId}/${claimToken}.${normalized.extension}`;
  try {
    await writePrivateObject(storageKey, normalized.bytes, claimToken);
    return await withTransaction(async (session: ClientSession) => {
      const current = await Asset.findOne({ _id: assetId, tenantId, status: "UPLOADING", uploadClaimToken: claimToken }).session(session);
      if (!current) throw new AppError(409, "ASSET_UPLOAD_CLAIM_LOST", "Upload processing lease expired; request a new upload intent");
      current.storageKey = storageKey;
      current.contentType = normalized.contentType;
      current.sizeBytes = normalized.bytes.length;
      current.sha256 = sha256(normalized.bytes);
      current.width = normalized.width;
      current.height = normalized.height;
      current.metadataStripped = true;
      current.status = "PENDING_SCAN";
      current.scanStatus = "PENDING";
      current.uploadNonceHash = null;
      current.uploadExpiresAt = null;
      current.uploadClaimToken = null;
      current.uploadClaimExpiresAt = null;
      current.aggregateVersion += 1;
      await current.save({ session });
      await recordAudit({ actorType: "USER", actorId: current.createdById.toString(), tenantId, action: "asset.uploaded", outcome: "SUCCEEDED", resourceType: "asset", resourceId: current.id, requestId, metadata: { contentType: current.contentType, sizeBytes: current.sizeBytes, width: current.width, height: current.height, metadataStripped: current.metadataStripped } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "asset.uploaded", schemaVersion: 1, aggregateType: "asset", aggregateId: current.id, aggregateVersion: current.aggregateVersion, visibility: "TENANT_PRIVATE", data: { assetId: current.id, status: current.status, scanStatus: current.scanStatus, version: current.aggregateVersion } }, session);
      return assetDto(current as unknown as Parameters<typeof assetDto>[0]);
    });
  } catch (error) {
    await rm(objectPath(storageKey), { force: true }).catch(() => undefined);
    await Asset.updateOne({ _id: assetId, tenantId, status: "UPLOADING", uploadClaimToken: claimToken }, { $set: { status: "PENDING_UPLOAD", uploadClaimToken: null, uploadClaimExpiresAt: null } }).catch(() => undefined);
    throw error;
  }
}

function clamAvScan(bytes: Buffer): Promise<"CLEAN" | "INFECTED"> {
  if (!env.ASSET_CLAMAV_HOST) throw new AppError(503, "ASSET_SCANNER_UNAVAILABLE", "Malware scanning is not configured");
  return new Promise((resolveScan, rejectScan) => {
    const socket = createConnection({ host: env.ASSET_CLAMAV_HOST, port: env.ASSET_CLAMAV_PORT });
    const response: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (error?: Error, result?: "CLEAN" | "INFECTED") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      if (error) rejectScan(error);
      else resolveScan(result!);
    };
    timer = setTimeout(() => finish(new Error("CLAMAV_TIMEOUT")), 20_000);
    socket.once("error", () => finish(new Error("CLAMAV_CONNECTION_FAILED")));
    socket.once("connect", () => {
      socket.write(Buffer.from("zINSTREAM\0"));
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const chunk = bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > 4096) return finish(new Error("CLAMAV_RESPONSE_TOO_LARGE"));
      response.push(chunk);
      if (!Buffer.concat(response).includes(0)) return;
      const message = Buffer.concat(response).toString("utf8").replace(/\0.*$/s, "");
      if (message.endsWith(": OK")) finish(undefined, "CLEAN");
      else if (message.includes(" FOUND")) finish(undefined, "INFECTED");
      else finish(new Error("CLAMAV_RESPONSE_INVALID"));
    });
  });
}

export async function scanAsset(tenantId: string, assetId: string, actorId: string, requestId: string, expectedVersion: number) {
  if (!validId(assetId)) throw new AppError(404, "ASSET_NOT_FOUND", "Asset was not found");
  if (!env.ASSET_CLAMAV_HOST) throw new AppError(503, "ASSET_SCANNER_UNAVAILABLE", "Malware scanning is not configured");
  const asset = await Asset.findOne({ _id: assetId, tenantId }).select("storageKey status scanStatus aggregateVersion");
  if (!asset) throw new AppError(404, "ASSET_NOT_FOUND", "Asset was not found");
  if (asset.aggregateVersion !== expectedVersion) throw new AppError(409, "STALE_ASSET_VERSION", "Asset changed; reload before retrying", { currentVersion: asset.aggregateVersion });
  if (asset.status !== "PENDING_SCAN" || !asset.storageKey) throw new AppError(409, "ASSET_NOT_AWAITING_SCAN", "Only uploaded assets awaiting a scan can be scanned");
  let result: "CLEAN" | "INFECTED";
  try {
    result = await clamAvScan(await readFile(objectPath(asset.storageKey)));
  } catch {
    throw new AppError(503, "ASSET_SCANNER_FAILED", "Malware scanner is unavailable; the asset remains private and pending scan");
  }
  const storageKey = asset.storageKey;
  const updated = await withTransaction(async (session: ClientSession) => {
    const current = await Asset.findOne({ _id: assetId, tenantId, status: "PENDING_SCAN", aggregateVersion: expectedVersion }).session(session);
    if (!current) throw new AppError(409, "STALE_ASSET_VERSION", "Asset changed during scanning; reload before retrying");
    current.scanStatus = result;
    current.status = result === "CLEAN" ? "PENDING_REVIEW" : "REJECTED";
    if (result === "INFECTED") current.storageKey = null;
    current.aggregateVersion += 1;
    await current.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "asset.scan.completed", outcome: "SUCCEEDED", resourceType: "asset", resourceId: current.id, requestId, metadata: { scanStatus: result, scanner: "CLAMAV" } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "asset.scan.completed", schemaVersion: 1, aggregateType: "asset", aggregateId: current.id, aggregateVersion: current.aggregateVersion, visibility: "TENANT_PRIVATE", data: { assetId: current.id, status: current.status, scanStatus: current.scanStatus, version: current.aggregateVersion } }, session);
    return assetDto(current as unknown as Parameters<typeof assetDto>[0]);
  });
  if (result === "INFECTED") await rm(objectPath(storageKey), { force: true }).catch(() => undefined);
  return updated;
}

export async function reviewAsset(tenantId: string, assetId: string, actorId: string, requestId: string, input: { expectedVersion: number; decision: "APPROVE" | "REJECT"; reason: string }) {
  if (!validId(assetId)) throw new AppError(404, "ASSET_NOT_FOUND", "Asset was not found");
  let rejectedStorageKey: string | null = null;
  const result = await withTransaction(async (session: ClientSession) => {
    const asset = await Asset.findOne({ _id: assetId, tenantId }).session(session);
    if (!asset) throw new AppError(404, "ASSET_NOT_FOUND", "Asset was not found");
    if (asset.aggregateVersion !== input.expectedVersion) throw new AppError(409, "STALE_ASSET_VERSION", "Asset changed; reload before retrying", { currentVersion: asset.aggregateVersion });
    if (["REJECTED", "DELETED"].includes(asset.status)) throw new AppError(409, "ASSET_NOT_REVIEWABLE", "This asset has already been rejected or deleted");
    if (input.decision === "APPROVE" && asset.status !== "PENDING_REVIEW") throw new AppError(409, "ASSET_NOT_REVIEWABLE", "Only a scanned asset awaiting review can be approved");
    if (input.decision === "APPROVE" && (asset.scanStatus !== "CLEAN" || !asset.metadataStripped)) throw new AppError(409, "ASSET_SAFETY_CHECKS_INCOMPLETE", "Asset must pass malware scanning and metadata removal before approval");
    asset.reviewedById = new Types.ObjectId(actorId);
    asset.reviewedAt = new Date();
    asset.reviewReason = input.reason;
    asset.status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (input.decision === "REJECT") {
      rejectedStorageKey = asset.storageKey;
      asset.storageKey = null;
      asset.uploadNonceHash = null;
      asset.uploadExpiresAt = null;
      asset.uploadClaimToken = null;
      asset.uploadClaimExpiresAt = null;
    }
    asset.aggregateVersion += 1;
    await asset.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "asset.moderated", outcome: "SUCCEEDED", resourceType: "asset", resourceId: asset.id, requestId, reason: input.reason, metadata: { decision: input.decision, status: asset.status, version: asset.aggregateVersion } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "asset.moderated", schemaVersion: 1, aggregateType: "asset", aggregateId: asset.id, aggregateVersion: asset.aggregateVersion, visibility: "TENANT_PRIVATE", data: { assetId: asset.id, status: asset.status, version: asset.aggregateVersion } }, session);
    return assetDto(asset as unknown as Parameters<typeof assetDto>[0]);
  });
  if (rejectedStorageKey) await rm(objectPath(rejectedStorageKey), { force: true }).catch(() => undefined);
  return result;
}

export async function listAssets(tenantId: string, limit: number, beforeId?: string, status?: string) {
  if (!validId(tenantId)) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
  const statusFilter = status === "PENDING_UPLOAD" ? { status: { $in: ["PENDING_UPLOAD", "UPLOADING"] } } : status ? { status } : {};
  const rows = await Asset.find({ tenantId, ...statusFilter, ...(beforeId ? { _id: { $lt: new Types.ObjectId(beforeId) } } : {}) })
    .sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { assets: page.map((asset) => assetDto(asset as unknown as Parameters<typeof assetDto>[0])), nextCursor: hasMore ? page.at(-1)?._id.toString() ?? null : null };
}

export async function getAsset(tenantId: string, assetId: string) {
  if (!validId(assetId)) throw new AppError(404, "ASSET_NOT_FOUND", "Asset was not found");
  const asset = await Asset.findOne({ _id: assetId, tenantId }).lean();
  if (!asset) throw new AppError(404, "ASSET_NOT_FOUND", "Asset was not found");
  return assetDto(asset as unknown as Parameters<typeof assetDto>[0]);
}

export async function getAssetContent(tenantId: string, assetId: string) {
  if (!validId(assetId)) throw new AppError(404, "ASSET_NOT_FOUND", "Asset was not found");
  const asset = await Asset.findOne({ _id: assetId, tenantId, status: { $in: ["PENDING_REVIEW", "APPROVED"] }, scanStatus: "CLEAN", metadataStripped: true }).select("storageKey contentType").lean();
  if (!asset?.storageKey || !asset.contentType) throw new AppError(404, "ASSET_CONTENT_NOT_FOUND", "Reviewed asset content was not found");
  try {
    return { contentType: asset.contentType, bytes: await readFile(objectPath(asset.storageKey)) };
  } catch {
    throw new AppError(404, "ASSET_CONTENT_NOT_FOUND", "Reviewed asset content was not found");
  }
}
