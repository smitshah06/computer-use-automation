import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunController } from "../../src/escalation/controller";
import { InterventionStore } from "../../src/escalation/store";
import { OperatorGateway } from "../../src/escalation/gateway";
import { verifyResolution } from "../../src/escalation/signing";
import { RunLogger } from "../../src/evidence/run-logger";
import { Redactor } from "../../src/evidence/redactor";
import { nowIso, type InterventionRequest } from "../../src/core";
import type { SurfaceDriver } from "../../src/surface";

let seq = 0;
function mkLogger(): RunLogger {
  seq += 1;
  return new RunLogger(`esc_unit_${seq}`, new Redactor(), mkdtempSync(join(tmpdir(), "scribe-esc-")));
}

function req(id: string, ttlMs = 60_000): InterventionRequest {
  return {
    id,
    runId: "r1",
    type: "assist",
    capabilityId: "cap",
    reason: "test intervention",
    currentUrl: "http://localhost/x",
    requestedAt: nowIso(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

describe("RunController control-ownership state machine", () => {
  it("walks the legal chain and logs every transition", () => {
    const logger = mkLogger();
    const c = new RunController(logger);
    expect(c.current).toBe("agent");
    c.transition("paused", "system", "checkpoint failed");
    c.transition("human", "op", "claimed");
    c.transition("agent", "op", "handed back");
    c.transition("paused", "system", "second intervention");
    c.transition("aborted", "op", "gave up");
    expect(c.current).toBe("aborted");

    const lines = readFileSync(join(logger.runDir, "run.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "control_transition");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatchObject({ actor: "system", from: "agent", to: "paused" });
    expect(lines[2]).toMatchObject({ from: "human", to: "agent", by: "op" });
  });

  it("rejects illegal transitions, including anything out of aborted", () => {
    const c = new RunController(mkLogger());
    expect(() => c.transition("human", "op", "no pause first")).toThrow(/illegal/);
    c.transition("paused", "system", "ok");
    c.transition("aborted", "op", "stop");
    expect(() => c.transition("agent", "op", "resurrect")).toThrow(/illegal/);
  });

  it("maintains a deterministic, tamper-evident hash chain over the custody trail", () => {
    const logger = mkLogger();
    const c = new RunController(logger);
    const genesis = c.chainHash;
    c.transition("paused", "system", "checkpoint failed");
    const h1 = c.chainHash;
    c.transition("human", "op", "claimed");
    const h2 = c.chainHash;
    expect(new Set([genesis, h1, h2]).size).toBe(3); // every transition moves the head

    // each logged transition carries the chain head it produced
    const logged = readFileSync(join(logger.runDir, "run.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "control_transition")
      .map((e) => e.chainHash);
    expect(logged).toEqual([h1, h2]);

    // deterministic: an auditor replaying the same transitions recomputes the
    // same heads — so editing any historical event breaks every later hash
    const c2 = new RunController(mkLogger());
    c2.transition("paused", "system", "checkpoint failed");
    expect(c2.chainHash).toBe(h1);
    c2.transition("human", "op", "claimed");
    expect(c2.chainHash).toBe(h2);

    const c3 = new RunController(mkLogger());
    c3.transition("paused", "system", "TAMPERED reason");
    expect(c3.chainHash).not.toBe(h1);
  });
});

describe("OperatorGateway control semantics", () => {
  const stubDriver = {
    startHumanCapture: async () => {},
    stopHumanCapture: async () => {},
  } as unknown as SurfaceDriver;

  it("returns control to the agent on deny/expired; only abort is terminal", async () => {
    const gw = new OperatorGateway(stubDriver, mkLogger());

    // deny hands control back — the RUN decides what a deny means
    const p1 = gw.requestIntervention({ ...req("iv_g1"), type: "approval" });
    gw.claim("iv_g1", "alice");
    gw.resolve("iv_g1", { disposition: "deny", operator: "alice" });
    await expect(p1).resolves.toMatchObject({ disposition: "deny" });
    expect(gw.controller.current).toBe("agent");

    // a continuing run can raise the NEXT intervention without an illegal
    // aborted -> paused transition (the crash this guards against)
    const p2 = gw.requestIntervention({ ...req("iv_g2"), type: "approval" });
    gw.claim("iv_g2", "alice");
    gw.resolve("iv_g2", { disposition: "abort", operator: "alice" });
    await expect(p2).resolves.toMatchObject({ disposition: "abort" });
    expect(gw.controller.current).toBe("aborted");
    gw.close();
  });

  it("signs operator dispositions, bound to the custody chain head at hand-back", async () => {
    const logger = mkLogger();
    const gw = new OperatorGateway(stubDriver, logger, { signingSecret: "unit-signing-secret" });
    const p = gw.requestIntervention({ ...req("iv_sig"), type: "approval" });
    gw.claim("iv_sig", "alice");
    const chainAtHandback = gw.controller.chainHash; // head while the human owns control
    const rec = gw.resolve("iv_sig", { disposition: "approve_once", operator: "alice", note: "ok" });
    await p;

    expect(rec.signature).toBeDefined();
    expect(rec.signature!.payload).toMatchObject({
      interventionId: "iv_sig",
      disposition: "approve_once",
      operator: "alice",
      controlChainHash: chainAtHandback,
    });
    expect(rec.signature!.payload.resolvedAt).toBe(rec.resolvedAt);
    expect(verifyResolution("unit-signing-secret", rec.signature!)).toBe(true);
    expect(verifyResolution("some-other-key", rec.signature!)).toBe(false);

    // the signature is persisted with the record, and a tampered disposition
    // in the file no longer matches the signed payload
    const persisted = JSON.parse(readFileSync(join(logger.runDir, "interventions.json"), "utf8"));
    expect(persisted[0].signature.value).toBe(rec.signature!.value);
    const tampered = { ...persisted[0].signature, payload: { ...persisted[0].signature.payload, disposition: "deny" } };
    expect(verifyResolution("unit-signing-secret", tampered)).toBe(false);
    gw.close();
  });

  it("leaves dispositions unsigned when no signing secret is configured", async () => {
    const gw = new OperatorGateway(stubDriver, mkLogger());
    const p = gw.requestIntervention({ ...req("iv_nosig"), type: "approval" });
    gw.claim("iv_nosig", "alice");
    const rec = gw.resolve("iv_nosig", { disposition: "deny", operator: "alice" });
    await p;
    expect(rec.signature).toBeUndefined();
    gw.close();
  });
});

describe("InterventionStore lifecycle and persistence", () => {
  it("parks the caller until resolve, then persists the full record", async () => {
    const logger = mkLogger();
    const store = new InterventionStore(logger);
    const pending = store.open(req("iv_1"));
    expect(store.get("iv_1")?.status).toBe("pending");

    store.claim("iv_1", "alice");
    expect(store.get("iv_1")).toMatchObject({ status: "claimed", claimedBy: "alice" });

    store.resolve("iv_1", { disposition: "completed_step", operator: "alice" });
    await expect(pending).resolves.toMatchObject({ disposition: "completed_step" });

    const persisted = JSON.parse(readFileSync(join(logger.runDir, "interventions.json"), "utf8"));
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      status: "resolved",
      claimedBy: "alice",
      resolution: { disposition: "completed_step" },
    });
    store.close();
  });

  it("enforces claim/resolve state rules", async () => {
    const store = new InterventionStore(mkLogger());
    const pending = store.open(req("iv_2"));
    expect(() => store.resolve("iv_2", { disposition: "abort" })).toThrow(/claim it before resolving/);
    store.claim("iv_2", "alice");
    expect(() => store.claim("iv_2", "bob")).toThrow(/not claimable/);
    expect(() => store.resolve("nope", { disposition: "abort" })).toThrow(/unknown/);
    store.resolve("iv_2", { disposition: "abort", operator: "alice" });
    expect(() => store.resolve("iv_2", { disposition: "abort" })).toThrow(/already resolved/);
    await pending;
    store.close();
  });

  it("stops the TTL clock once a human has claimed the intervention", async () => {
    const store = new InterventionStore(mkLogger());
    const pending = store.open(req("iv_4", 60)); // would expire in 60ms unattended
    store.claim("iv_4", "alice");
    await new Promise((r) => setTimeout(r, 120));
    expect(store.get("iv_4")?.status).toBe("claimed"); // still owned by the human
    store.resolve("iv_4", { disposition: "completed_step", operator: "alice" });
    await expect(pending).resolves.toMatchObject({ disposition: "completed_step" });
    store.close();
  });

  it("enforces custody: only the claiming operator can resolve", async () => {
    const store = new InterventionStore(mkLogger());
    const pending = store.open(req("iv_5"));
    store.claim("iv_5", "alice");
    expect(() => store.resolve("iv_5", { disposition: "abort", operator: "mallory" })).toThrow(/claimed by "alice"/);
    expect(() => store.resolve("iv_5", { disposition: "abort" })).toThrow(/claimed by "alice"/);
    store.resolve("iv_5", { disposition: "completed_step", operator: "alice" });
    await expect(pending).resolves.toMatchObject({ disposition: "completed_step" });
    store.close();
  });

  it("log payloads cannot clobber the envelope fields of the audit trail", () => {
    const logger = mkLogger();
    logger.log("system", "intervention_requested", { request: { type: "approval" }, type: "evil" });
    const line = JSON.parse(readFileSync(join(logger.runDir, "run.jsonl"), "utf8").trim().split("\n")[0]!);
    expect(line.type).toBe("intervention_requested"); // envelope wins
    expect(line.type_).toBe("evil"); // colliding payload key preserved, renamed
    expect(line.request.type).toBe("approval"); // nested payload untouched
  });

  it("resolves with disposition expired when the TTL elapses", async () => {
    const store = new InterventionStore(mkLogger());
    const r = await store.open(req("iv_3", 60));
    expect(r.disposition).toBe("expired");
    expect(store.get("iv_3")?.status).toBe("expired");
    expect(() => store.claim("iv_3", "late")).toThrow(/not claimable/);
    store.close();
  });
});
