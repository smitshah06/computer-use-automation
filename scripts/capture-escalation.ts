// Captures the escalation evidence scenario end to end against the running
// target app: arm one-shot session expiry, replay until the checkpoint fails,
// then play the OPERATOR through the real console HTTP API — claim, fix the
// live session, hand back with completed_step — and let the engine finish.
// In a live demo a person does the middle part in the headed browser window;
// here the operator's actions are driven programmatically (phase:"human"),
// which exercises the identical control-transfer path and audit trail.
//
// Usage: tsx scripts/capture-escalation.ts [capabilities/member-savings-lookup.json]

import { existsSync, readFileSync } from "node:fs";
import {
  CapabilityArtifactSchema,
  loadSecretsFromEnv,
  resolveTemplate,
  type StepTarget,
  type TemplateContext,
} from "../src/core";
import { PolicyEngine, loadPolicyConfig } from "../src/policy/engine";
import { PlaywrightDriver } from "../src/surface";
import { Redactor } from "../src/evidence/redactor";
import { RunLogger } from "../src/evidence/run-logger";
import { ReplayEngine } from "../src/replay";
import { OperatorConsole, OperatorGateway, newConsoleToken } from "../src/escalation";
import type { InterventionRecord } from "../src/escalation/store";

const CAP_PATH = process.argv[2] ?? "capabilities/member-savings-lookup.json";
const OPERATOR = "operator-jsmith";
// Same auth posture as the CLI composition root: the console never starts
// unauthenticated, and operator dispositions are HMAC-signed into evidence.
const AUTH_TOKEN = process.env.SCRIBE_CONSOLE_TOKEN ?? newConsoleToken();
const SIGNING_SECRET = process.env.SCRIBE_SIGNING_SECRET ?? AUTH_TOKEN;
const AUTH = { "x-scribe-token": AUTH_TOKEN };

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 200));
  }
}

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadPolicyConfig("policy.yaml");
  const artifact = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(CAP_PATH, "utf8")));
  const base = new URL(artifact.policy.requiredOrigins[0]!).origin;
  const consoleUrl = `http://127.0.0.1:${config.escalation.operatorPort}`;

  const secrets = loadSecretsFromEnv(process.env, config.redaction.extraSecretEnvPrefixes);
  if (!secrets.tellerUsername || !secrets.tellerPassword) {
    throw new Error("set SCRIBE_SECRET_TELLER_USERNAME and SCRIBE_SECRET_TELLER_PASSWORD first");
  }
  const ctx: TemplateContext = { inputs: { memberId: "12345" }, secrets, env: { APP_BASE_URL: base } };
  const materialize = (t: StepTarget): StepTarget => ({
    ...t,
    strategies: t.strategies.map((s) => {
      if (s.kind === "role") return { ...s, name: s.name ? resolveTemplate(s.name, ctx) : s.name };
      if (s.kind === "bbox") return s;
      return { ...s, value: resolveTemplate(s.value, ctx) };
    }),
  });

  const armed = await fetch(`${base}/__faults?arm=session-expiry`);
  if (!armed.ok) throw new Error(`could not arm session-expiry fault (${armed.status}) — is the target app running?`);
  console.log("fault armed: session-expiry (one-shot)");

  const policy = new PolicyEngine(config);
  policy.bindArtifact(artifact.policy, artifact.provenance.reviewStatus);
  const logger = new RunLogger(
    `replay_escalation_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`,
    new Redactor(),
    "evidence",
  );
  const driver = new PlaywrightDriver(policy, logger);
  const gateway = new OperatorGateway(driver, logger, { signingSecret: SIGNING_SECRET });
  const operatorConsole = new OperatorConsole(gateway, {
    port: config.escalation.operatorPort,
    runDir: logger.runDir,
    authToken: AUTH_TOKEN,
  });
  await operatorConsole.start();

  const engine = new ReplayEngine(artifact, config, driver, logger, {
    secrets,
    env: { APP_BASE_URL: base },
    gateway,
  });
  const runPromise = engine.run({ memberId: "12345" });

  try {
    const iv = await until<InterventionRecord>(async () => {
      const list = (await (await fetch(`${consoleUrl}/api/interventions`, { headers: AUTH })).json()) as InterventionRecord[];
      return list.find((x) => x.status === "pending");
    });
    console.log(`intervention pending: ${iv.request.id} — ${iv.request.reason}`);

    const claim = await fetch(`${consoleUrl}/api/interventions/${iv.request.id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ operator: OPERATOR }),
    });
    if (!claim.ok) throw new Error(`claim failed (${claim.status})`);
    console.log(`claimed by ${OPERATOR} — control is with the human`);

    // The human re-authenticates in the SAME live browser session.
    const step = (id: string) => {
      const s = artifact.steps.find((x) => x.id === id);
      if (!s?.target) throw new Error(`artifact has no step ${id} with a target — adjust the capture script`);
      return s;
    };
    const acts = [
      { s: step("s2"), sensitive: false, intent: "human: re-enter teller id" },
      { s: step("s3"), sensitive: true, intent: "human: re-enter passcode" },
    ];
    for (const { s, sensitive, intent } of acts) {
      const r = await driver.act({
        kind: "fill",
        target: materialize(s.target!),
        value: resolveTemplate(s.value!, ctx),
        sensitive,
        risk: "safe",
        phase: "human",
        intent,
      });
      if (!r.ok) throw new Error(`human fill failed: ${r.error ?? "unknown"}`);
    }
    const signIn = await driver.act({
      kind: "click",
      target: materialize(step("s4").target!),
      risk: "safe",
      phase: "human",
      intent: "human: sign in again",
    });
    if (!signIn.ok) throw new Error(`human click failed: ${signIn.error ?? "unknown"}`);
    console.log("human re-authenticated in the live session");

    const resolve = await fetch(`${consoleUrl}/api/interventions/${iv.request.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({
        disposition: "completed_step",
        operator: OPERATOR,
        note: "re-authenticated in the live session; step's own checkpoint should now hold",
      }),
    });
    if (!resolve.ok) throw new Error(`resolve failed (${resolve.status})`);
    console.log("handed back: completed_step — engine verifies the step checkpoint and resumes");

    const result = await runPromise;
    console.log(`\nrun finished: ${result.result.status}`);
    console.log(JSON.stringify(result.result, null, 2));
    console.log(`evidence: ${result.evidenceDir}`);
    if (result.result.status !== "escalated" || result.result.finalStatus !== "success") {
      process.exitCode = 1;
    }
  } finally {
    gateway.close();
    await operatorConsole.stop();
  }
}

main().catch((e: unknown) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(2);
});
