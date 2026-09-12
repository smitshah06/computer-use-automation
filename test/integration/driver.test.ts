import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createTargetApp } from "../../src/target-app/server";
import { PlaywrightDriver } from "../../src/surface/playwright-driver";
import { PolicyEngine, loadPolicyConfig } from "../../src/policy/engine";
import { Redactor } from "../../src/evidence/redactor";
import { RunLogger } from "../../src/evidence/run-logger";
import {
  CapabilityArtifactSchema,
  resolveTemplate,
  type StepTarget,
  type TemplateContext,
} from "../../src/core";
import { makeFixtureArtifact } from "../fixtures/artifact-fixture";

const PORT = 4610;
const BASE = `http://localhost:${PORT}`;

const ctx: TemplateContext = {
  inputs: { memberId: "12345" },
  secrets: { tellerUsername: "teller1", tellerPassword: "Demo!Pass1" },
  env: { APP_BASE_URL: BASE },
};

const artifact = CapabilityArtifactSchema.parse(makeFixtureArtifact({ baseUrl: BASE }));

function step(id: string) {
  const s = artifact.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

// The replay engine's job (Phase 5): materialize template refs in values and
// strategy strings before handing targets to the driver.
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

let server: Server;
let driver: PlaywrightDriver;
let logger: RunLogger;

beforeAll(async () => {
  server = createTargetApp().listen(PORT);
  const config = loadPolicyConfig("policy.yaml");
  const policy = new PolicyEngine({
    ...config,
    allowlist: { ...config.allowlist, origins: [BASE] },
  });
  policy.bindArtifact(artifact.policy, artifact.provenance.reviewStatus);
  logger = new RunLogger("itest_driver", new Redactor(), mkdtempSync(join(tmpdir(), "scribe-ev-")));
  driver = new PlaywrightDriver(policy, logger);
  await driver.launch();
});

afterAll(async () => {
  await driver.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("PlaywrightDriver against the mock CU back-office", () => {
  it("navigates through act() and observes labeled controls from the a11y view", async () => {
    const res = await driver.act({ kind: "navigate", url: `${BASE}/login`, risk: "safe", phase: "replay" });
    expect(res.ok).toBe(true);

    const obs = await driver.observe();
    expect(obs.title).toContain("Teller Sign-In");
    const teller = obs.nodes.find((n) => n.role === "textbox" && n.name === "Teller ID");
    expect(teller).toBeDefined();
    expect(teller!.ref).toMatch(/^f\d+e\d+$/);
    expect(obs.pageText).toContain("Teller Sign-In");

    expect(await driver.evalCondition(step("s1").checkpoint!)).toBe(true);
  });

  it("enforces policy inside act(): origin deny, artifact kind deny, risky approval gate", async () => {
    const cross = await driver.act({
      kind: "navigate",
      url: "https://evil.example.com/page",
      risk: "safe",
      phase: "replay",
    });
    expect(cross.ok).toBe(false);
    expect(cross.denied).toMatch(/not allowlisted/);

    // global config allows "press", but this capability's policy does not
    const press = await driver.act({ kind: "press", key: "Enter", risk: "safe", phase: "replay" });
    expect(press.ok).toBe(false);
    expect(press.denied).toMatch(/capability's policy/);

    // risky during discovery requires an approval intervention; nothing happens
    const before = driver.url();
    const risky = await driver.act({
      kind: "click",
      target: materialize(step("s4").target!),
      risk: "risky",
      phase: "discovery",
    });
    expect(risky.ok).toBe(false);
    expect(risky.needsApproval).toMatch(/discovery/);
    expect(driver.url()).toBe(before);
  });

  it("resolves ranked strategies and fails closed on ambiguity", async () => {
    const r = await driver.resolve(materialize(step("s2").target!));
    expect(r).toEqual({ status: "ok", rank: 0, kind: "role" });

    const ambiguous = await driver.resolve({
      strategies: [{ kind: "css", value: "input" }],
      elementDescription: "any input (deliberately ambiguous)",
      framePath: [],
    });
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status === "ambiguous") expect(ambiguous.count).toBe(3);

    const missing = await driver.resolve({
      strategies: [
        { kind: "role", role: "textbox", name: "Routing Number" },
        { kind: "css", value: "#no_such_control" },
      ],
      elementDescription: "control that does not exist",
      framePath: [],
    });
    expect(missing.status).toBe("not_found");
    if (missing.status === "not_found") expect(missing.tried).toHaveLength(2);
  });

  it("fills credentials, masks sensitive state at the source, and writes a masked screenshot", async () => {
    const s2 = await driver.act({
      kind: "fill",
      target: materialize(step("s2").target!),
      value: resolveTemplate(step("s2").value!, ctx),
      sensitive: true,
      risk: "safe",
      phase: "replay",
      stepId: "s2",
    });
    expect(s2).toMatchObject({ ok: true, strategyRank: 0, strategyKind: "role" });

    const s3 = await driver.act({
      kind: "fill",
      target: materialize(step("s3").target!),
      value: resolveTemplate(step("s3").value!, ctx),
      sensitive: true,
      risk: "safe",
      phase: "replay",
      stepId: "s3",
    });
    expect(s3.ok).toBe(true);

    // password value is masked in the observation itself, not post-hoc
    const obs = await driver.observe();
    const pass = obs.nodes.find((n) => n.name === "Passcode");
    expect(pass?.value).toBe("***");

    const shot = logger.nextScreenshotPath("credentials");
    await driver.screenshot(shot.abs);
    expect(statSync(shot.abs).size).toBeGreaterThan(1000);
  });

  it("signs in and verifies the checkpoint conditions", async () => {
    const res = await driver.act({
      kind: "click",
      target: materialize(step("s4").target!),
      risk: "safe",
      phase: "replay",
      stepId: "s4",
    });
    expect(res.ok).toBe(true);
    expect(await driver.waitForCondition(step("s4").checkpoint!, 5000)).toBe(true);
    expect(driver.url()).toContain("/desk");
  });

  it("searches for the member, falling back to nearText where the markup has no label", async () => {
    const s5 = await driver.act({
      kind: "click",
      target: materialize(step("s5").target!),
      risk: "safe",
      phase: "replay",
      stepId: "s5",
    });
    expect(s5).toMatchObject({ ok: true, strategyRank: 0 });
    expect(await driver.waitForCondition(step("s5").checkpoint!, 5000)).toBe(true);

    expect(await driver.waitForCondition(step("s6").waitBefore!.condition, 5000)).toBe(true);
    const s6 = await driver.act({
      kind: "fill",
      target: materialize(step("s6").target!),
      value: resolveTemplate(step("s6").value!, ctx),
      risk: "safe",
      phase: "replay",
      stepId: "s6",
    });
    // the search field has no <label>: role and labelText miss, nearText resolves
    expect(s6).toMatchObject({ ok: true, strategyRank: 2, strategyKind: "nearText" });

    const s7 = await driver.act({
      kind: "click",
      target: materialize(step("s7").target!),
      risk: "safe",
      phase: "replay",
      stepId: "s7",
    });
    expect(s7.ok).toBe(true);
    expect(await driver.waitForCondition(step("s7").checkpoint!, 5000)).toBe(true);

    const s8 = await driver.act({
      kind: "click",
      target: materialize(step("s8").target!),
      risk: "safe",
      phase: "replay",
      stepId: "s8",
    });
    expect(s8).toMatchObject({ ok: true, strategyRank: 0, strategyKind: "nearText" });
    expect(await driver.waitForCondition(step("s8").checkpoint!, 5000)).toBe(true);
  });

  it("extracts the savings balance via row-scoped nearText and a post-processing pattern", async () => {
    const s9 = await driver.act({
      kind: "extract",
      target: materialize(step("s9").target!),
      extractPattern: step("s9").extractPattern,
      sensitive: true, // savingsBalance output is declared sensitive
      risk: "safe",
      phase: "replay",
      stepId: "s9",
    });
    expect(s9.ok).toBe(true);
    expect(s9.extracted).toBe("$1,204.55");
    expect(await driver.evalCondition(artifact.successCheckpoint)).toBe(true);
  });

  it("synthesizes a semantic-first target from a live ref", async () => {
    await driver.act({ kind: "navigate", url: `${BASE}/login`, risk: "safe", phase: "replay" });
    const obs = await driver.observe();
    const teller = obs.nodes.find((n) => n.role === "textbox" && n.name === "Teller ID")!;

    const synth = await driver.synthesizeTarget(teller.ref);
    expect(synth).not.toBeNull();
    expect(synth!.role).toBe("textbox");
    expect(synth!.name).toBe("Teller ID");
    expect(synth!.target.strategies[0]).toEqual({ kind: "role", role: "textbox", name: "Teller ID" });
    const kinds = synth!.target.strategies.map((s) => s.kind);
    expect(kinds).toContain("labelText");
    expect(kinds).toContain("css");
    expect(kinds).toContain("bbox");
    const css = synth!.target.strategies.find((s) => s.kind === "css");
    expect(css).toMatchObject({ value: expect.stringContaining("ctl00_LoginCtl_txtUser") });

    // a synthesized target must resolve back to the same element, rank 0
    expect(await driver.resolve(synth!.target)).toEqual({ status: "ok", rank: 0, kind: "role" });
  });

  it("keeps every secret and sensitive value out of the evidence log", async () => {
    const jsonl = readFileSync(join(logger.runDir, "run.jsonl"), "utf8");
    expect(jsonl.length).toBeGreaterThan(0);
    expect(jsonl).not.toContain("Demo!Pass1");
    expect(jsonl).not.toContain("teller1");
    expect(jsonl).not.toContain("$1,204.55");
    expect(jsonl).toContain("***");
  });
});
