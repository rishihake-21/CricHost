import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  displayName: z.string().trim().min(2).max(80),
  password: z.string().min(12).max(72),
}).strict();

export const verifyEmailSchema = z.object({ token: z.string().min(32).max(200) }).strict();
export const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(72),
}).strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
