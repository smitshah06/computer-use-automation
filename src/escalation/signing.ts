import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Tamper-evident dispositions. A resolution record ("alice approved this
// risky step") is an accountability artifact — anyone with write access to
// the evidence directory could otherwise edit it after the fact. Each
// operator disposition is HMAC-signed over a canonical payload that includes
// the control-ownership hash-chain head at the moment of hand-back, binding
// WHO approved WHAT to the exact custody history it happened under.
//
// HMAC with one shared key (not asymmetric signatures) is a deliberate scope
// cut: verifier == trusted auditor holding the same key. Production would
// swap KMS-held asymmetric keys in behind this same seam; nothing outside
// this module knows the algorithm.
// ---------------------------------------------------------------------------

const DOMAIN = "scribe.resolution.v1";

export interface ResolutionSignaturePayload {
  interventionId: string;
  disposition: string;
  operator: string;
  controlChainHash: string; // RunController chain head when the operator handed back
  resolvedAt: string;
}

export interface ResolutionSignature {
  alg: "HMAC-SHA256";
  keyId: string; // fingerprint of the signing key — identifies it, reveals nothing
  payload: ResolutionSignaturePayload;
  value: string; // hex mac
}

export function keyFingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 12);
}

// Fixed-order JSON array: unambiguous (no delimiter-injection via field
// values) and independent of object key order.
function mac(secret: string, p: ResolutionSignaturePayload): string {
  const canonical = JSON.stringify([DOMAIN, p.interventionId, p.disposition, p.operator, p.controlChainHash, p.resolvedAt]);
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

export function signResolution(secret: string, payload: ResolutionSignaturePayload): ResolutionSignature {
  return { alg: "HMAC-SHA256", keyId: keyFingerprint(secret), payload, value: mac(secret, payload) };
}

export function verifyResolution(secret: string, sig: ResolutionSignature): boolean {
  if (sig.alg !== "HMAC-SHA256" || sig.keyId !== keyFingerprint(secret)) return false;
  const expected = Buffer.from(mac(secret, sig.payload), "hex");
  const actual = Buffer.from(sig.value, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(expected, actual);
}

export function newConsoleToken(): string {
  return randomBytes(16).toString("hex");
}

// Timing-safe bearer-token equality for the console: hashing both sides first
// means the comparison never short-circuits on length.
export function tokenMatches(supplied: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(supplied, "utf8").digest(),
    createHash("sha256").update(expected, "utf8").digest(),
  );
}
