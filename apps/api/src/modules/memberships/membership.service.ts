import { createHash, randomBytes } from "node:crypto";
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { env } from "../../platform/config/env.js";
import { AppError } from "../../platform/errors/app-error.js";
import { withTransaction } from "../../platform/db/transaction.js";
import { recordAudit } from "../audit/audit.service.js";
import { enqueueOutboxEvent } from "../outbox/outbox.service.js";
import { TeamStaff } from "../teams/models/team-staff.model.js";
import { Auction } from "../auctions/models/auction.model.js";
import { AuctionBidder } from "../auctions/models/auction-bidder.model.js";
import { Tenant } from "../tenants/models/tenant.model.js";
import { User } from "../identity/models/user.model.js";
import { Invitation } from "./models/invitation.model.js";
import { Membership } from "./models/membership.model.js";
import type { CreateInvitationInput } from "./membership.schemas.js";
import { assertWithinQuota } from "../usage/usage.service.js";

const newToken = () => randomBytes(32).toString("base64url");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const validId = (id: string) => Types.ObjectId.isValid(id) && /^[a-f\d]{24}$/i.test(id);
const invitationDto = (invitation: { _id: Types.ObjectId; tenantId: Types.ObjectId; email: string; role: string; status: string; invitedById: Types.ObjectId; expiresAt: Date; createdAt: Date; aggregateVersion: number }) => ({ id: invitation._id.toString(), tenantId: invitation.tenantId.toString(), email: invitation.email, role: invitation.role, status: invitation.status, invitedById: invitation.invitedById.toString(), expiresAt: invitation.expiresAt, createdAt: invitation.createdAt, version: invitation.aggregateVersion });

async function requireActorMembership(tenantId: string, actorId: string, session?: ClientSession) {
  const query = Membership.findOne({ tenantId, userId: actorId, status: "ACTIVE" });
  if (session) query.session(session);
  const membership = await query;
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) throw new AppError(403, "PERMISSION_DENIED", "Organization owner or administrator permission is required");
  return membership;
}

export async function createTenantInvitation(tenantId: string, actorId: string, requestId: string, input: CreateInvitationInput) {
  if (!validId(tenantId)) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
  if (!env.exposeDevTokens) throw new AppError(503, "INVITATION_DELIVERY_UNAVAILABLE", "Invitation delivery is unavailable until an email provider is configured");
  const email = input.email.toLowerCase();
  const token = newToken();
  const now = new Date();
  try {
    return await withTransaction(async (session: ClientSession) => {
      const tenant = await Tenant.findOne({ _id: tenantId, status: { $ne: "ARCHIVED" } }).session(session);
      if (!tenant) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
      const actorMembership = await requireActorMembership(tenantId, actorId, session);
      if (input.role === "ADMIN" && actorMembership.role !== "OWNER") throw new AppError(403, "PERMISSION_DENIED", "Only an organization owner may invite an administrator");
      const existingUser = await User.findOne({ email }).select("_id status").session(session);
      if (existingUser?.status === "DISABLED") throw new AppError(409, "INVITEE_ACCOUNT_DISABLED", "This account cannot accept an organization invitation");
      if (existingUser) {
        const membership = await Membership.findOne({ tenantId, userId: existingUser._id }).session(session);
        if (membership?.status === "ACTIVE" || membership?.status === "SUSPENDED") throw new AppError(409, "ALREADY_ORGANIZATION_MEMBER", "This account already belongs to the organization");
      }
      const prior = await Invitation.findOne({ tenantId, email, status: "PENDING" }).session(session);
      if (prior) {
        if (prior.expiresAt > now) throw new AppError(409, "INVITATION_ALREADY_PENDING", "An active invitation already exists for this email");
        prior.status = "EXPIRED";
        prior.tokenHash = undefined;
        prior.aggregateVersion += 1;
        await prior.save({ session });
        await recordAudit({ actorType: "USER", actorId, tenantId, action: "tenant.invitation.expired", outcome: "SUCCEEDED", resourceType: "tenant_invitation", resourceId: prior.id, requestId, metadata: { role: prior.role } }, session);
        await enqueueOutboxEvent({ tenantId, eventType: "tenant.invitation.expired", schemaVersion: 1, aggregateType: "tenant_invitation", aggregateId: prior.id, aggregateVersion: prior.aggregateVersion, visibility: "TENANT_PRIVATE", data: { invitationId: prior.id, status: prior.status } }, session);
      }
      await assertWithinQuota(tenantId, "activeMembers", session, async (activeSession) => {
        const activeMembers = await Membership.countDocuments({ tenantId, status: "ACTIVE" }).session(activeSession);
        const pendingInvitations = await Invitation.countDocuments({ tenantId, status: "PENDING", expiresAt: { $gt: now } }).session(activeSession);
        return activeMembers + pendingInvitations;
      });
      const [invitation] = await Invitation.create([{
        tenantId, email, role: input.role, status: "PENDING", tokenHash: hashToken(token), invitedById: actorId,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
      }], { session });
      if (!invitation) throw new Error("Invitation creation returned no record");
      await recordAudit({ actorType: "USER", actorId, tenantId, action: "tenant.invitation.created", outcome: "SUCCEEDED", resourceType: "tenant_invitation", resourceId: invitation.id, requestId, metadata: { email, role: invitation.role } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "tenant.invitation.created", schemaVersion: 1, aggregateType: "tenant_invitation", aggregateId: invitation.id, aggregateVersion: invitation.aggregateVersion, visibility: "TENANT_PRIVATE", data: { invitationId: invitation.id, role: invitation.role, expiresAt: invitation.expiresAt } }, session);
      return { invitation: invitationDto(invitation), developmentInvitationToken: token };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "INVITATION_ALREADY_PENDING", "An active invitation already exists for this email");
    throw error;
  }
}

export async function listTenantInvitations(tenantId: string) {
  const rows = await Invitation.find({ tenantId, status: "PENDING", expiresAt: { $gt: new Date() } }).sort({ createdAt: -1, _id: -1 }).lean();
  return rows.map((row) => invitationDto(row as unknown as Parameters<typeof invitationDto>[0]));
}

export async function acceptTenantInvitation(tenantId: string, invitationId: string, userId: string, token: string, requestId: string) {
  if (!validId(tenantId) || !validId(invitationId)) throw new AppError(404, "INVITATION_NOT_FOUND", "Invitation was not found");
  const tokenHash = hashToken(token);
  try {
    return await withTransaction(async (session: ClientSession) => {
    const invitation = await Invitation.findOne({ _id: invitationId, tenantId, status: "PENDING", tokenHash }).select("+tokenHash").session(session);
    if (!invitation) throw new AppError(400, "INVALID_OR_EXPIRED_INVITATION", "The invitation is invalid, expired, or no longer active");
    const now = new Date();
    if (invitation.expiresAt <= now) {
      throw new AppError(400, "INVALID_OR_EXPIRED_INVITATION", "The invitation is invalid, expired, or no longer active");
    }
    const user = await User.findOne({ _id: userId, status: "ACTIVE" }).session(session);
    if (!user || !user.emailVerifiedAt) throw new AppError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your account email before accepting an organization invitation");
    if (user.email.toLowerCase() !== invitation.email) throw new AppError(403, "INVITATION_EMAIL_MISMATCH", "Sign in with the email address this invitation was sent to");
    const tenant = await Tenant.findOne({ _id: tenantId, status: { $ne: "ARCHIVED" } }).session(session);
    if (!tenant) throw new AppError(404, "TENANT_NOT_FOUND", "Organization was not found");
    let membership = await Membership.findOne({ tenantId, userId }).session(session);
    if (membership?.status === "ACTIVE") throw new AppError(409, "ALREADY_ORGANIZATION_MEMBER", "This account already belongs to the organization");
    if (membership?.status === "SUSPENDED") throw new AppError(409, "MEMBERSHIP_SUSPENDED", "Contact an organization owner about this suspended membership");
    if (membership) {
      membership.role = invitation.role;
      membership.status = "ACTIVE";
      membership.invitedById = invitation.invitedById;
      membership.joinedAt = now;
      membership.aggregateVersion += 1;
      await membership.save({ session });
    } else {
      [membership] = await Membership.create([{
        tenantId, userId, role: invitation.role, status: "ACTIVE", invitedById: invitation.invitedById, joinedAt: now, aggregateVersion: 1,
      }], { session });
    }
    if (!membership) throw new Error("Membership activation returned no record");
    invitation.status = "ACCEPTED";
    invitation.acceptedById = new Types.ObjectId(userId);
    invitation.acceptedAt = now;
    invitation.tokenHash = undefined;
    invitation.aggregateVersion += 1;
    await invitation.save({ session });
    await recordAudit({ actorType: "USER", actorId: userId, tenantId, action: "tenant.invitation.accepted", outcome: "SUCCEEDED", resourceType: "membership", resourceId: membership.id, requestId, metadata: { role: membership.role, invitationId: invitation.id } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "tenant.membership.activated", schemaVersion: 1, aggregateType: "membership", aggregateId: membership.id, aggregateVersion: membership.aggregateVersion, visibility: "TENANT_PRIVATE", data: { tenantId, userId, role: membership.role, invitationId: invitation.id } }, session);
    return { tenantId, userId, role: membership.role, status: membership.status, version: membership.aggregateVersion };
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) throw new AppError(409, "INVITATION_ALREADY_ACCEPTED", "This invitation has already been consumed");
    throw error;
  }
}

export async function revokeTenantInvitation(tenantId: string, invitationId: string, actorId: string, requestId: string, reason: string) {
  if (!validId(tenantId) || !validId(invitationId)) throw new AppError(404, "INVITATION_NOT_FOUND", "Invitation was not found");
  return withTransaction(async (session: ClientSession) => {
    const actorMembership = await requireActorMembership(tenantId, actorId, session);
    const invitation = await Invitation.findOne({ _id: invitationId, tenantId, status: "PENDING" }).select("+tokenHash").session(session);
    if (!invitation) throw new AppError(404, "INVITATION_NOT_FOUND", "Pending invitation was not found");
    if (invitation.role === "ADMIN" && actorMembership.role !== "OWNER") throw new AppError(403, "PERMISSION_DENIED", "Only an organization owner may revoke an administrator invitation");
    invitation.status = invitation.expiresAt <= new Date() ? "EXPIRED" : "REVOKED";
    invitation.tokenHash = undefined;
    invitation.aggregateVersion += 1;
    await invitation.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: invitation.status === "EXPIRED" ? "tenant.invitation.expired" : "tenant.invitation.revoked", outcome: "SUCCEEDED", resourceType: "tenant_invitation", resourceId: invitation.id, requestId, reason, metadata: { role: invitation.role } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: invitation.status === "EXPIRED" ? "tenant.invitation.expired" : "tenant.invitation.revoked", schemaVersion: 1, aggregateType: "tenant_invitation", aggregateId: invitation.id, aggregateVersion: invitation.aggregateVersion, visibility: "TENANT_PRIVATE", data: { invitationId: invitation.id, status: invitation.status } }, session);
    return invitationDto(invitation);
  });
}

export async function updateTenantMemberRole(tenantId: string, userId: string, actorId: string, requestId: string, role: "ADMIN" | "MEMBER") {
  if (!validId(userId)) throw new AppError(404, "MEMBER_NOT_FOUND", "Organization member was not found");
  return withTransaction(async (session: ClientSession) => {
    const actorMembership = await requireActorMembership(tenantId, actorId, session);
    const membership = await Membership.findOne({ tenantId, userId, status: "ACTIVE" }).session(session);
    if (!membership || membership.role === "OWNER") throw new AppError(404, "MEMBER_NOT_FOUND", "Organization member was not found");
    if (actorMembership.role !== "OWNER" && (membership.role !== "MEMBER" || role !== "MEMBER")) throw new AppError(403, "PERMISSION_DENIED", "Only an organization owner may change administrator roles");
    if (membership.role === role) return { userId, role: membership.role, status: membership.status, version: membership.aggregateVersion };
    membership.role = role;
    membership.aggregateVersion += 1;
    await membership.save({ session });
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "tenant.membership.role_changed", outcome: "SUCCEEDED", resourceType: "membership", resourceId: membership.id, requestId, metadata: { userId, role } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "tenant.membership.role_changed", schemaVersion: 1, aggregateType: "membership", aggregateId: membership.id, aggregateVersion: membership.aggregateVersion, visibility: "TENANT_PRIVATE", data: { tenantId, userId, role, status: membership.status } }, session);
    return { userId, role: membership.role, status: membership.status, version: membership.aggregateVersion };
  });
}

export async function removeTenantMember(tenantId: string, userId: string, actorId: string, requestId: string, reason: string) {
  if (!validId(userId)) throw new AppError(404, "MEMBER_NOT_FOUND", "Organization member was not found");
  return withTransaction(async (session: ClientSession) => {
    const actorMembership = await requireActorMembership(tenantId, actorId, session);
    const membership = await Membership.findOne({ tenantId, userId, status: "ACTIVE" }).session(session);
    if (!membership || membership.role === "OWNER") throw new AppError(404, "MEMBER_NOT_FOUND", "Organization member was not found");
    if (actorMembership.role !== "OWNER" && membership.role !== "MEMBER") throw new AppError(403, "PERMISSION_DENIED", "Only an organization owner may remove an administrator");
    membership.status = "REMOVED";
    membership.aggregateVersion += 1;
    await membership.save({ session });
    await TeamStaff.updateMany({ tenantId, userId, status: "ACTIVE" }, { $set: { status: "REMOVED" } }, { session });
    const bidderAssignments = await AuctionBidder.find({ tenantId, userId, status: "ACTIVE" }).session(session);
    for (const assignment of bidderAssignments) {
      assignment.status = "REMOVED";
      await assignment.save({ session });
      const auction = await Auction.findOne({ _id: assignment.auctionId, tenantId }).session(session);
      if (!auction) continue;
      auction.aggregateVersion += 1;
      await auction.save({ session });
      await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.bidder.removed", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auction.id, requestId, reason, metadata: { teamId: assignment.teamId.toString(), userId, removedWithMembership: true } }, session);
      await enqueueOutboxEvent({ tenantId, eventType: "auction.bidder.removed", schemaVersion: 1, aggregateType: "auction", aggregateId: auction.id, aggregateVersion: auction.aggregateVersion, visibility: "TENANT_PRIVATE", data: { auctionId: auction.id, teamId: assignment.teamId.toString(), userId, status: assignment.status } }, session);
      const activeTeamBidders = await AuctionBidder.countDocuments({ tenantId, auctionId: auction._id, teamId: assignment.teamId, status: "ACTIVE" }).session(session);
      if (auction.status === "LIVE" && activeTeamBidders === 0) {
        auction.status = "PAUSED";
        auction.aggregateVersion += 1;
        await auction.save({ session });
        await recordAudit({ actorType: "USER", actorId, tenantId, action: "auction.paused", outcome: "SUCCEEDED", resourceType: "auction", resourceId: auction.id, requestId, reason: "Auction bidder lost organization access", metadata: { teamId: assignment.teamId.toString(), removedUserId: userId } }, session);
        await enqueueOutboxEvent({ tenantId, eventType: "auction.paused", schemaVersion: 1, aggregateType: "auction", aggregateId: auction.id, aggregateVersion: auction.aggregateVersion, visibility: "TENANT_PRIVATE", data: { auctionId: auction.id, reasonCode: "BIDDER_ACCESS_REVOKED" } }, session);
      }
    }
    const user = await User.findById(userId).select("email").session(session);
    if (user) {
      const pendingInvitations = await Invitation.find({ tenantId, email: user.email, status: "PENDING" }).session(session);
      for (const invitation of pendingInvitations) {
        invitation.status = "REVOKED";
        invitation.tokenHash = undefined;
        invitation.aggregateVersion += 1;
        await invitation.save({ session });
        await recordAudit({ actorType: "USER", actorId, tenantId, action: "tenant.invitation.revoked", outcome: "SUCCEEDED", resourceType: "tenant_invitation", resourceId: invitation.id, requestId, reason, metadata: { role: invitation.role, revokedWithMembership: true } }, session);
        await enqueueOutboxEvent({ tenantId, eventType: "tenant.invitation.revoked", schemaVersion: 1, aggregateType: "tenant_invitation", aggregateId: invitation.id, aggregateVersion: invitation.aggregateVersion, visibility: "TENANT_PRIVATE", data: { invitationId: invitation.id, status: invitation.status } }, session);
      }
    }
    await recordAudit({ actorType: "USER", actorId, tenantId, action: "tenant.membership.removed", outcome: "SUCCEEDED", resourceType: "membership", resourceId: membership.id, requestId, reason, metadata: { userId, previousRole: membership.role } }, session);
    await enqueueOutboxEvent({ tenantId, eventType: "tenant.membership.removed", schemaVersion: 1, aggregateType: "membership", aggregateId: membership.id, aggregateVersion: membership.aggregateVersion, visibility: "TENANT_PRIVATE", data: { tenantId, userId, status: membership.status } }, session);
    return { userId, role: membership.role, status: membership.status, version: membership.aggregateVersion };
  });
}
