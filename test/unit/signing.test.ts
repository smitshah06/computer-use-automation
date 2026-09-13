import { describe, it, expect } from "vitest";
import {
  keyFingerprint,
  newConsoleToken,
  signResolution,
  tokenMatches,
  verifyResolution,
  type ResolutionSignaturePayload,
} from "../../src/escalation/signing";

const payload: ResolutionSignaturePayload = {
  interventionId: "iv_42",
  disposition: "approve_once",
  operator: "alice",
  controlChainHash: "c0ffee".repeat(10) + "abcd",
  resolvedAt: "2026-09-12T10:00:00.000Z",
};

describe("resolution signing", () => {
  it("round-trips: a signature verifies with the signing key and carries its fingerprint", () => {
    const sig = signResolution("s3cret-key", payload);
    expect(sig.alg).toBe("HMAC-SHA256");
    expect(sig.keyId).toBe(keyFingerprint("s3cret-key"));
    expect(sig.keyId).toHaveLength(12);
    expect(sig.keyId).not.toContain("s3cret"); // identifies the key, reveals nothing
    expect(sig.value).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyResolution("s3cret-key", sig)).toBe(true);
  });

  it("rejects tampering with any signed field", () => {
    const sig = signResolution("s3cret-key", payload);
    for (const field of Object.keys(payload) as Array<keyof ResolutionSignaturePayload>) {
      const forged = { ...sig, payload: { ...sig.payload, [field]: "mallory" } };
      expect(verifyResolution("s3cret-key", forged), `tampered ${field} must not verify`).toBe(false);
    }
    const flipped = (sig.value[0] === "0" ? "1" : "0") + sig.value.slice(1);
    expect(verifyResolution("s3cret-key", { ...sig, value: flipped })).toBe(false);
    expect(verifyResolution("s3cret-key", { ...sig, value: "ff" })).toBe(false); // truncated mac
  });

  it("rejects the wrong key outright (fingerprint mismatch, then mac mismatch)", () => {
    const sig = signResolution("key-one", payload);
    expect(verifyResolution("key-two", sig)).toBe(false);
    // even a forged keyId cannot help without the actual key
    expect(verifyResolution("key-two", { ...sig, keyId: keyFingerprint("key-two") })).toBe(false);
  });

  it("field values cannot smuggle delimiters into the canonical form", () => {
    // If canonicalization were naive string-joining, these two payloads would
    // collide. They must produce different macs.
    const a = signResolution("k", { ...payload, disposition: "deny", operator: '","x' });
    const b = signResolution("k", { ...payload, disposition: 'deny","x', operator: "" });
    expect(a.value).not.toBe(b.value);
  });
});

describe("console token helpers", () => {
  it("generates distinct 32-hex tokens", () => {
    const t1 = newConsoleToken();
    const t2 = newConsoleToken();
    expect(t1).toMatch(/^[0-9a-f]{32}$/);
    expect(t1).not.toBe(t2);
  });

  it("tokenMatches compares exactly, including across lengths", () => {
    expect(tokenMatches("abc123", "abc123")).toBe(true);
    expect(tokenMatches("abc123", "abc124")).toBe(false);
    expect(tokenMatches("", "abc123")).toBe(false);
    expect(tokenMatches("abc123extra", "abc123")).toBe(false);
  });
});
