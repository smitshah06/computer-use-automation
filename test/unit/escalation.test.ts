import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunController } from "../../src/escalation/controller";
import { InterventionStore } from "../../src/escalation/store";
import { RunLogger } from "../../src/evidence/run-logger";
import { Redactor } from "../../src/evidence/redactor";
import { nowIso, type InterventionRequest } from "../../src/core";

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

  it("resolves with disposition expired when the TTL elapses", async () => {
    const store = new InterventionStore(mkLogger());
    const r = await store.open(req("iv_3", 60));
    expect(r.disposition).toBe("expired");
    expect(store.get("iv_3")?.status).toBe("expired");
    expect(() => store.claim("iv_3", "late")).toThrow(/not claimable/);
    store.close();
  });
});
