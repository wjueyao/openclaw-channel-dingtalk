import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_SKEW_MS = 60 * 60 * 1000;

/**
 * Generate DingTalk custom-bot style signature.
 * Sign payload format: `${timestamp}\n${secret}`
 */
export function generateDingTalkSignature(timestamp: string | number, secret: string): string {
  if (!secret) {
    throw new Error("secret is required for DingTalk signature generation");
  }

  const timestampText = String(timestamp);
  const payload = `${timestampText}\n${secret}`;
  return createHmac("sha256", secret).update(payload).digest("base64");
}

export function verifyDingTalkSignature(params: {
  timestamp?: string | number | null;
  sign?: string | null;
  secret?: string | null;
  now?: number;
  maxSkewMs?: number;
}): boolean {
  const timestampText = String(params.timestamp ?? "").trim();
  const signText = String(params.sign ?? "").trim();
  const secret = String(params.secret ?? "").trim();

  if (!timestampText || !signText || !secret) {
    return false;
  }

  const timestampMs = Number(timestampText);
  if (!Number.isFinite(timestampMs)) {
    return false;
  }

  const now = params.now ?? Date.now();
  const maxSkewMs = params.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  if (Math.abs(now - timestampMs) > maxSkewMs) {
    return false;
  }

  const expectedSign = generateDingTalkSignature(timestampText, secret);
  const expected = Buffer.from(expectedSign, "utf-8");
  const actual = Buffer.from(signText, "utf-8");
  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}
