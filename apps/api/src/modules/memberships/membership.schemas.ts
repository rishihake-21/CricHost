import { z } from "zod";

export const createInvitationSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
}).strict();

export const acceptInvitationSchema = z.object({
  token: z.string().min(32).max(128),
}).strict();

export const revokeInvitationSchema = z.object({
  reason: z.string().trim().min(10).max(500),
}).strict();

export const updateMemberRoleSchema = z.object({
  role: z.enum(["ADMIN", "MEMBER"]),
}).strict();

export const removeMemberSchema = z.object({
  reason: z.string().trim().min(10).max(500),
}).strict();

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
