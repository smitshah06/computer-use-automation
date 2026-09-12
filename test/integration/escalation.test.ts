import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createTargetApp } from "../../src/target-app/server";
import { PlaywrightDriver } from "../../src/surface/playwright-driver";
import { PolicyEngine, loadPolicyConfig } from "../../src/policy/engine";
import { Redactor } from "../../src/evidence/redactor";
import { RunLogger } from "../../src/evidence/run-logger";
import { ReplayEngine } from "../../src/replay/executor";
import { OperatorGateway, OperatorConsole } from "../../src/escalation";
import {
  CapabilityArtifactSchema,
  resolveTemplate,
  type PolicyConfig,
  type StepTarget,
  type TemplateContext,
} from "../../src/core";
import { makeFixtureArtifact } from "../fixtures/artifact-fixture";
import type { InterventionRecord } from "../../src/escalation/store";

const PORT = 4612;
const BASE = `http://localhost:${PORT}`;
const CONSOLE_PORT = 4712;
const CONSOLE = `http://127.0.0.1:${CONSOLE_PORT}`;
const SECRETS = { tellerUsername: "teller1", tellerPassword: "Demo!Pass1" };

const ctx: TemplateContext = {
  inputs: { memberId: "12345" },
  secrets: SECRETS,
  env: { APP_BASE_URL: BASE },
};

let server: Server;
let config: PolicyConfig;

beforeAll(() => {
  server = createTargetApp().listen(PORT);
  const loaded = loadPolicyConfig("policy.yaml");
  config = { ...loaded, allowlist: { ...loaded.allowlist, origins: [BASE] } };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function materialize(target: StepTarget): StepTarget {
  return {
    ...target,
    strategies: target.strategies.map((s) => {
      if (s.kind === "role") return { ...s, name: s.name ? resolveTemplate(s.name, ctx) : s.name };
      if (s.kind === "bbox") return s;
      return { ...s, value: resolveTemplate(s.value, ctx) };
    }),
  };
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe("Escalation: live-session handoff through the operator console", () => {
  it("pauses on an unrecoverable deviation, lets a human fix the live session, and resumes", async () => {
    // Arm one-shot session expiry: the engine's own sign-in lands on
    // /login?expired=1, s4's checkpoint fails, and no recovery is declared.
    const armed = await fetch(`${BASE}/__faults?arm=session-expiry`);
    expect(armed.ok).toBe(true);

    const artifact = CapabilityArtifactSchema.parse(makeFixtureArtifact({ baseUrl: BASE }));
    const policy = new PolicyEngine(config);
    policy.bindArtifact(artifact.policy, artifact.provenance.reviewStatus);
    const logger = new RunLogger("escalation_itest", new Redactor(), mkdtempSync(join(tmpdir(), "scribe-esc-")));
    const driver = new PlaywrightDriver(policy, logger);
    const gateway = new OperatorGateway(driver, logger);
    const operatorConsole = new OperatorConsole(gateway, { port: CONSOLE_PORT, runDir: logger.runDir });
    await operatorConsole.start();

    const engine = new ReplayEngine(artifact, config, driver, logger, { secrets: SECRETS, gateway });
    const runPromise = engine.run({ memberId: "12345" });

    try {
      // The console shows the pending intervention with full context.
      const iv = await until<InterventionRecord>(async () => {
        const list = (await (await fetch(`${CONSOLE}/api/interventions`)).json()) as InterventionRecord[];
        return list.find((x) => x.status === "pending");
      });
      expect(iv.request).toMatchObject({ type: "assist", stepId: "s4", capabilityId: artifact.capability.id });
      expect(iv.request.reason).toContain("urlMatches");

      const html = await (await fetch(`${CONSOLE}/`)).text();
      expect(html).toContain("Operator Console");
      const shot = await fetch(`${CONSOLE}/shot/${iv.request.id}`);
      expect(shot.status).toBe(200);
      expect(shot.headers.get("content-type")).toContain("image/png");

      // Operator claims → control transfers to the human, capture starts.
      const claim = await fetch(`${CONSOLE}/api/interventions/${iv.request.id}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator: "itest-operator" }),
      });
      expect(claim.ok).toBe(true);
      expect(gateway.controller.current).toBe("human");

      const doubleClaim = await fetch(`${CONSOLE}/api/interventions/${iv.request.id}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operator: "second-operator" }),
      });
      expect(doubleClaim.status).toBe(409);

      // The "human" re-authenticates in the SAME live session (same driver,
      // same cookies). In the demo this is real mouse/keyboard in the headed
      // window; here we drive it programmatically with phase:"human".
      const s = (id: string) => artifact.steps.find((x) => x.id === id)!;
      const fillUser = await driver.act({
        kind: "fill",
        target: materialize(s("s2").target!),
        value: SECRETS.tellerUsername,
        risk: "safe",
        phase: "human",
        intent: "human: re-enter teller id",
      });
      expect(fillUser.ok).toBe(true);
      const fillPass = await driver.act({
        kind: "fill",
        target: materialize(s("s3").target!),
        value: SECRETS.tellerPassword,
        sensitive: true,
        risk: "safe",
        phase: "human",
        intent: "human: re-enter passcode",
      });
      expect(fillPass.ok).toBe(true);
      const signIn = await driver.act({
        kind: "click",
        target: materialize(s("s4").target!),
        risk: "safe",
        phase: "human",
        intent: "human: sign in again",
      });
      expect(signIn.ok).toBe(true);

      // Hand back: the step's work is done; the engine verifies s4's own
      // checkpoint before continuing from s5.
      const resolve = await fetch(`${CONSOLE}/api/interventions/${iv.request.id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disposition: "completed_step", operator: "itest-operator", note: "re-authenticated" }),
      });
      expect(resolve.ok).toBe(true);

      const result = await runPromise;
      expect(result.result.status).toBe("escalated");
      if (result.result.status === "escalated") {
        expect(result.result.finalStatus).toBe("success");
        expect(result.result.outputs?.savingsBalance).toBe("$1,204.55");
        expect(result.result.interventions[0]).toMatchObject({
          type: "assist",
          disposition: "completed_step",
          operator: "itest-operator",
        });
      }
      expect(gateway.controller.current).toBe("agent");

      // Audit trail: chain of custody + the human's actions, fully redacted.
      const events = readFileSync(join(logger.runDir, "run.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const transitions = events
        .filter((e) => e.type === "control_transition")
        .map((e) => `${e.from}>${e.to}`);
      expect(transitions).toEqual(["agent>paused", "paused>human", "human>agent"]);

      const humanActs = events.filter((e) => e.actor === "human" && String(e.type).startsWith("act_"));
      expect(humanActs.length).toBeGreaterThanOrEqual(3);
      const captured = events.filter((e) => e.type === "human_action").map((e) => e.kind);
      expect(captured).toContain("input");
      expect(captured).toContain("click");
      expect(captured).toContain("navigate");

      const jsonl = readFileSync(join(logger.runDir, "run.jsonl"), "utf8");
      expect(jsonl).not.toContain("Demo!Pass1");

      const persisted = JSON.parse(readFileSync(join(logger.runDir, "interventions.json"), "utf8"));
      expect(persisted[0]).toMatchObject({ status: "resolved", claimedBy: "itest-operator" });
    } finally {
      gateway.close();
      await operatorConsole.stop();
    }
  }, 90_000);
});
