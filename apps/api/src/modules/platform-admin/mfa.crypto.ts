import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "../../platform/config/env.js";
import { AppError } from "../../platform/errors/app-error.js";

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const totpPeriodSeconds = 30;
const totpDigits = 6;

function encryptionKey(): Buffer {
  const keyHex = env.PLATFORM_MFA_ENCRYPTION_KEY;
  if (!keyHex) throw new AppError(503, "PLATFORM_MFA_UNAVAILABLE", "Platform administrator MFA is not configured on this server");
  return Buffer.from(keyHex, "hex");
}

function encodeBase32(value: Buffer): string {
  let accumulator = 0;
  let bits = 0;
  let result = "";
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += base32Alphabet[(accumulator >>> (bits - 5)) & 31];
      bits -= 5;
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits > 0) result += base32Alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/=+$/, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new AppError(503, "PLATFORM_MFA_SECRET_INVALID", "The stored platform MFA secret is invalid");
  let accumulator = 0;
  let bits = 0;
  const result: number[] = [];
  for (const character of normalized) {
    const digit = base32Alphabet.indexOf(character);
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      result.push((accumulator >>> (bits - 8)) & 255);
      bits -= 8;
    }
    accumulator &= (1 << bits) - 1;
  }
  return Buffer.from(result);
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function createTotpUri(email: string, secret: string): string {
  const label = encodeURIComponent(`CricHost:${email}`);
  const query = new URLSearchParams({ secret, issuer: "CricHost", algorithm: "SHA1", digits: String(totpDigits), period: String(totpPeriodSeconds) });
  return `otpauth://totp/${label}?${query.toString()}`;
}

export function encryptMfaSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptMfaSecret(encrypted: string): string {
  const [encodedIv, encodedTag, encodedCiphertext, ...extra] = encrypted.split(".");
  if (!encodedIv || !encodedTag || !encodedCiphertext || extra.length > 0) {
    throw new AppError(503, "PLATFORM_MFA_SECRET_INVALID", "The stored platform MFA secret is invalid");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encodedIv, "base64url"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, "PLATFORM_MFA_DECRYPTION_FAILED", "The platform MFA secret cannot be decrypted; check the configured encryption key");
  }
}

function totpAtStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return (binary % (10 ** totpDigits)).toString().padStart(totpDigits, "0");
}

export function verifyTotpCode(secret: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const currentStep = Math.floor(nowMs / (totpPeriodSeconds * 1000));
  for (const step of [currentStep, currentStep - 1, currentStep + 1]) {
    if (step < 0) continue;
    const expected = Buffer.from(totpAtStep(secret, step));
    const supplied = Buffer.from(code);
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) return step;
  }
  return null;
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => randomBytes(16).toString("hex").toUpperCase().match(/.{1,8}/g)!.join("-"));
}

export function hashRecoveryCode(code: string): string | null {
  const normalized = code.toUpperCase().replace(/[-\s]/g, "");
  if (!/^[A-F\d]{32}$/.test(normalized)) return null;
  return createHash("sha256").update(normalized).digest("hex");
}
