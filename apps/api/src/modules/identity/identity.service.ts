import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../platform/errors/app-error.js";
import { env } from "../../platform/config/env.js";
import { Session } from "./models/session.model.js";
import { User } from "./models/user.model.js";
import type { LoginInput, RegisterInput } from "./identity.schemas.js";

const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const newToken = (): string => randomBytes(32).toString("base64url");
const publicUser = (user: { id: string; email: string; displayName: string; emailVerifiedAt: Date | null }) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  emailVerified: user.emailVerifiedAt !== null,
});

type Credentials = { accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date };

async function createSession(userId: string, userAgent: string | undefined): Promise<Credentials> {
  const now = Date.now();
  const accessToken = newToken();
  const refreshToken = newToken();
  const accessExpiresAt = new Date(now + env.SESSION_ACCESS_MINUTES * 60_000);
  const refreshExpiresAt = new Date(now + env.SESSION_REFRESH_DAYS * 86_400_000);
  await Session.create({
    userId,
    accessTokenHash: tokenHash(accessToken),
    refreshTokenHash: tokenHash(refreshToken),
    accessExpiresAt,
    refreshExpiresAt,
    userAgent: userAgent?.slice(0, 300) ?? null,
    lastSeenAt: new Date(now),
  });
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

export async function register(input: RegisterInput) {
  if (env.NODE_ENV === "production") {
    throw new AppError(503, "VERIFICATION_DELIVERY_UNAVAILABLE", "Account registration is unavailable until email verification delivery is configured");
  }
  if (Buffer.byteLength(input.password, "utf8") > 72) {
    throw new AppError(400, "VALIDATION_FAILED", "Password must be at most 72 bytes when encoded as UTF-8");
  }
  const email = input.email.toLowerCase();
  const exists = await User.exists({ email });
  if (exists) throw new AppError(409, "EMAIL_ALREADY_REGISTERED", "An account with this email already exists");

  const verificationToken = newToken();
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  try {
    const user = await User.create({
      email,
      displayName: input.displayName,
      passwordHash,
      verificationTokenHash: tokenHash(verificationToken),
      verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    return {
      user: publicUser({ id: user.id, email: user.email, displayName: user.displayName, emailVerifiedAt: user.emailVerifiedAt }),
      ...(env.exposeDevTokens ? { developmentVerificationToken: verificationToken } : {}),
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) {
      throw new AppError(409, "EMAIL_ALREADY_REGISTERED", "An account with this email already exists");
    }
    throw error;
  }
}

export async function verifyEmail(token: string) {
  const now = new Date();
  const user = await User.findOneAndUpdate(
    { verificationTokenHash: tokenHash(token), verificationExpiresAt: { $gt: now }, emailVerifiedAt: null },
    { $set: { emailVerifiedAt: now }, $unset: { verificationTokenHash: 1, verificationExpiresAt: 1 } },
    { new: true },
  );
  if (!user) throw new AppError(400, "INVALID_OR_EXPIRED_VERIFICATION_TOKEN", "The verification link is invalid or has expired");
  return publicUser({ id: user.id, email: user.email, displayName: user.displayName, emailVerifiedAt: user.emailVerifiedAt });
}

export async function login(input: LoginInput, userAgent?: string) {
  const user = await User.findOne({ email: input.email.toLowerCase() }).select("+passwordHash");
  const passwordMatches = user ? await bcrypt.compare(input.password, user.passwordHash) : false;
  if (!user || !passwordMatches) throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  if (user.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_DISABLED", "This account is disabled");
  if (!user.emailVerifiedAt) throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email before signing in");
  const credentials = await createSession(user.id, userAgent);
  return { user: publicUser({ id: user.id, email: user.email, displayName: user.displayName, emailVerifiedAt: user.emailVerifiedAt }), credentials };
}

export async function refresh(refreshToken: string, userAgent?: string) {
  const now = new Date();
  const oldHash = tokenHash(refreshToken);
  const session = await Session.findOne({ refreshTokenHash: oldHash, refreshExpiresAt: { $gt: now }, revokedAt: null }).select("+refreshTokenHash");
  if (!session) throw new AppError(401, "INVALID_SESSION", "The session is invalid or expired");
  const user = await User.findById(session.userId);
  if (!user || user.status !== "ACTIVE" || !user.emailVerifiedAt) throw new AppError(401, "INVALID_SESSION", "The session is invalid or expired");

  const accessToken = newToken();
  const nextRefreshToken = newToken();
  const accessExpiresAt = new Date(Date.now() + env.SESSION_ACCESS_MINUTES * 60_000);
  const refreshExpiresAt = new Date(Date.now() + env.SESSION_REFRESH_DAYS * 86_400_000);
  const rotated = await Session.updateOne(
    { _id: session._id, refreshTokenHash: oldHash, refreshExpiresAt: { $gt: now }, revokedAt: null },
    { $set: { accessTokenHash: tokenHash(accessToken), refreshTokenHash: tokenHash(nextRefreshToken), accessExpiresAt, refreshExpiresAt, userAgent: userAgent?.slice(0, 300) ?? null, lastSeenAt: new Date() } },
  );
  if (rotated.modifiedCount !== 1) throw new AppError(401, "INVALID_SESSION", "The session has already been rotated or revoked");
  return { accessToken, refreshToken: nextRefreshToken, accessExpiresAt, refreshExpiresAt };
}

export async function logout(refreshToken?: string, accessToken?: string): Promise<void> {
  const hashes = [refreshToken, accessToken].filter((value): value is string => Boolean(value)).map(tokenHash);
  if (hashes.length === 0) return;
  await Session.updateOne({ $or: [{ refreshTokenHash: { $in: hashes } }, { accessTokenHash: { $in: hashes } }], revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function findUserForAccessToken(accessToken: string) {
  const session = await Session.findOne({ accessTokenHash: tokenHash(accessToken), accessExpiresAt: { $gt: new Date() }, refreshExpiresAt: { $gt: new Date() }, revokedAt: null });
  if (!session) return null;
  const user = await User.findById(session.userId);
  if (!user || user.status !== "ACTIVE") return null;
  return publicUser({ id: user.id, email: user.email, displayName: user.displayName, emailVerifiedAt: user.emailVerifiedAt });
}
