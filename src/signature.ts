import { createHmac, timingSafeEqual } from "node:crypto";

// Stripe-compatible scheme: header "t=<unix>,v1=<hex hmac sha256 of `${t}.${rawBody}`>".
// Verified against the RAW body, with a timestamp tolerance, using a constant-time compare.
export type SigResult = { ok: true } | { ok: false; reason: string };

export function sign(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export function verify(
  rawBody: string,
  header: string | undefined,
  secret: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): SigResult {
  if (!header) return { ok: false, reason: "missing signature header" };
  const parts: Record<string, string> = {};
  for (const p of header.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) parts[p.slice(0, i)] = p.slice(i + 1);
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return { ok: false, reason: "malformed signature header" };
  if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, reason: "timestamp outside tolerance" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}
