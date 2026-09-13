import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import {
  CapabilityArtifactSchema,
  loadSecretsFromEnv,
  type CapabilityArtifact,
  type Outcome,
  type PolicyConfig,
  type RunResult,
} from "../core";
import { PolicyEngine, loadPolicyConfig } from "../policy/engine";
import { PlaywrightDriver } from "../surface";
import { Redactor } from "../evidence/redactor";
import { RunLogger } from "../evidence/run-logger";
import { ReplayEngine } from "../replay";
import { DiscoveryEngine } from "../agent";
import { makeProvider } from "../llm";
import { OperatorConsole, OperatorGateway } from "../escalation";
import { buildHealthReport, collectRunResults, renderHealthReport } from "../evidence/locator-health";

const CAPS_DIR = "capabilities";
const EVIDENCE_DIR = "evidence";

// Minimal .env support so API keys and SCRIBE_SECRET_* values never need to
// live in shell history. Existing environment variables win.
function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = v;
  }
}
loadDotEnv();

const collect = (v: string, prev: string[]): string[] => [...prev, v];

function parseKv(pairs: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new Error(`${flag} expects key=value, got "${pair}"`);
    const key = pair.slice(0, i);
    // keys become {{inputs.<key>}} template names — keep them to that grammar
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new Error(`${flag} key "${key}" must match [a-zA-Z_][a-zA-Z0-9_]*`);
    }
    out[key] = pair.slice(i + 1);
  }
  return { ...out };
}

function stamp(prefix: string): string {
  return `${prefix}_${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
}

function capabilityPath(idOrPath: string): string {
  return idOrPath.endsWith(".json") ? idOrPath : join(CAPS_DIR, `${idOrPath}.json`);
}

function loadArtifact(idOrPath: string): { artifact: CapabilityArtifact; path: string } {
  const path = capabilityPath(idOrPath);
  if (!existsSync(path)) throw new Error(`capability not found: ${path} (run discover first, or pass a path)`);
  return { artifact: CapabilityArtifactSchema.parse(JSON.parse(readFileSync(path, "utf8"))), path };
}

function saveArtifact(path: string, artifact: unknown): void {
  mkdirSync(CAPS_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(artifact, null, 2) + "\n");
}

// Same-process operator surface: the intervention promise parks inside this
// process, so the console (and the headed browser the human takes over) must
// live here too.
async function withOperatorConsole<T>(
  config: PolicyConfig,
  driver: PlaywrightDriver,
  logger: RunLogger,
  enabled: boolean,
  fn: (gateway: OperatorGateway | undefined) => Promise<T>,
): Promise<T> {
  if (!enabled) return fn(undefined);
  const gateway = new OperatorGateway(driver, logger);
  const operatorConsole = new OperatorConsole(gateway, {
    port: config.escalation.operatorPort,
    runDir: logger.runDir,
  });
  await operatorConsole.start();
  console.log(`operator console: http://127.0.0.1:${config.escalation.operatorPort}/ (interventions appear there)`);
  try {
    return await fn(gateway);
  } finally {
    await operatorConsole.stop();
    gateway.close();
  }
}

function printResult(result: RunResult): void {
  console.log(`\nrun ${result.runId} finished: ${result.result.status}`);
  console.log(JSON.stringify(result.result, null, 2));
  const ranks = result.telemetry
    .filter((t) => t.strategyRank !== null)
    .map((t) => `${t.stepId}:${t.strategyKind}#${t.strategyRank}`);
  if (ranks.length) console.log(`locator ranks: ${ranks.join("  ")}`);
  console.log(`evidence: ${result.evidenceDir}`);
}

function exitCode(result: RunResult): number {
  const r = result.result;
  if (r.status === "success" || r.status === "business_outcome") return 0;
  if (r.status === "escalated") return r.finalStatus === "success" || r.finalStatus === "business_outcome" ? 0 : 1;
  return 1;
}

const program = new Command();
program.name("scribe").description("LLM discovery → capability artifact → deterministic replay → human escalation");

program
  .command("discover")
  .description("Use an LLM to accomplish a goal against the live UI and record it as a capability artifact")
  .requiredOption("--goal <text>", "natural-language goal")
  .requiredOption("--entry <url>", "entry URL of the target application")
  .requiredOption("--id <capabilityId>", "capability id, e.g. member-savings-lookup")
  .option("--name <text>", "human-readable capability name")
  .option("--app <appId>", "target application id")
  .option("--input <k=v>", "task input (repeatable)", collect, [])
  .option("--sensitive-input <name>", "mark an input as sensitive (repeatable)", collect, [])
  .option("--env <k=v>", "environment binding, e.g. APP_BASE_URL=... (repeatable; defaults to the entry origin)", collect, [])
  .option("--provider <name>", "llm provider: anthropic | openai", process.env.SCRIBE_PROVIDER ?? "anthropic")
  .option("--model <model>", "model override")
  .option("--max-turns <n>", "turn budget override")
  .option("--headed", "show the browser window", false)
  .option("--no-console", "do not start the operator console (risky actions will not be approvable)")
  .option("--policy <path>", "policy config", "policy.yaml")
  .action(async (o) => {
    const config = loadPolicyConfig(o.policy);
    const inputs = parseKv(o.input, "--input");
    const env = parseKv(o.env, "--env");
    if (!Object.keys(env).length) env.APP_BASE_URL = new URL(o.entry).origin;

    const logger = new RunLogger(stamp("disc"), new Redactor(), EVIDENCE_DIR);
    const driver = new PlaywrightDriver(new PolicyEngine(config), logger, { headed: o.headed });
    const provider = makeProvider(o.provider, o.model);
    console.log(`discovery run ${logger.runId} — provider ${provider.name} (${provider.model})`);

    const out = await withOperatorConsole(config, driver, logger, o.console, (gateway) => {
      const engine = new DiscoveryEngine(provider, config, driver, logger, {
        goal: o.goal,
        entryUrl: o.entry,
        capabilityId: o.id,
        capabilityName: o.name,
        appId: o.app,
        inputs,
        sensitiveInputs: o.sensitiveInput,
        env,
      }, { gateway, maxTurns: o.maxTurns ? Number(o.maxTurns) : undefined });
      return engine.run();
    });

    logger.writeJson("discovery-summary.json", {
      status: out.status,
      summary: out.summary,
      turns: out.turns,
      capabilityId: o.id,
    });
    console.log(`\ndiscovery finished: ${out.status} after ${out.turns} turns — ${out.summary}`);
    console.log(`evidence: ${logger.runDir}`);

    if (out.status === "recorded") {
      const path = capabilityPath(o.id);
      saveArtifact(path, out.artifact);
      console.log(`capability written: ${path} (${out.artifact!.steps.length} steps, riskLevel=${out.artifact!.policy.riskLevel}, reviewStatus=draft)`);
      return;
    }
    if (out.status === "business_outcome" && out.outcome) {
      logger.writeJson("outcome.json", out.outcome);
      enrichWithOutcome(o.id, out.outcome);
      return;
    }
    process.exitCode = 1;
  });

// A discovery run that ends in a declared business outcome (e.g. searching a
// member that does not exist) enriches the already-recorded capability: the
// outcome becomes a first-class declared state replay can classify.
function enrichWithOutcome(capabilityId: string, outcome: Outcome): void {
  const path = capabilityPath(capabilityId);
  if (!existsSync(path)) {
    console.log(`declared outcome ${outcome.code}, but no ${path} exists yet — record the happy path first to persist it`);
    return;
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const codes = new Set((raw.outcomes ?? []).map((x: Outcome) => x.code));
  if (codes.has(outcome.code)) {
    console.log(`capability already declares outcome ${outcome.code} — nothing to merge`);
    return;
  }
  raw.outcomes = [...(raw.outcomes ?? []), outcome];
  // The review gate covers the artifact's declared semantics; merging a new
  // outcome changes them, so an approved artifact drops back to draft (and
  // gets a patch bump) until a human re-approves.
  const wasApproved = raw.provenance?.reviewStatus === "approved";
  if (wasApproved) {
    raw.provenance.reviewStatus = "draft";
    delete raw.provenance.reviewedBy;
    delete raw.provenance.reviewedAt;
    const [maj = NaN, min = NaN, pat = NaN] = String(raw.capability.version).split(".").map(Number);
    if (Number.isFinite(maj) && Number.isFinite(min) && Number.isFinite(pat)) {
      raw.capability.version = `${maj}.${min}.${pat + 1}`;
    }
  }
  saveArtifact(path, CapabilityArtifactSchema.parse(raw));
  console.log(
    `capability enriched: ${path} now declares outcome ${outcome.code}` +
      (wasApproved ? ` (review status reset to draft as v${raw.capability.version} — re-run approve)` : ""),
  );
}

program
  .command("replay")
  .description("Deterministically replay a recorded capability — no LLM, no API key")
  .requiredOption("--capability <idOrPath>", "capability id (in capabilities/) or artifact path")
  .option("--param <k=v>", "capability input (repeatable)", collect, [])
  .option("--env <k=v>", "environment binding (repeatable; APP_BASE_URL defaults to the recorded origin)", collect, [])
  .option("--inject <fault>", "arm a target-app fault first: interstitial | slow | session-expiry | error500")
  .option("--headed", "show the browser window (required for a human to take over on escalation)", false)
  .option("--no-console", "do not start the operator console (escalations cannot be resolved)")
  .option("--policy <path>", "policy config", "policy.yaml")
  .action(async (o) => {
    const config = loadPolicyConfig(o.policy);
    const { artifact, path } = loadArtifact(o.capability);
    const params = parseKv(o.param, "--param");
    const env = parseKv(o.env, "--env");
    if (!env.APP_BASE_URL) env.APP_BASE_URL = new URL(artifact.policy.requiredOrigins[0]!).origin;

    if (o.inject) {
      const res = await fetch(`${artifact.policy.requiredOrigins[0]}/__faults?arm=${o.inject}`);
      if (!res.ok) throw new Error(`failed to arm fault "${o.inject}" (${res.status})`);
      console.log(`fault armed: ${o.inject}`);
    }

    const policy = new PolicyEngine(config);
    policy.bindArtifact(artifact.policy, artifact.provenance.reviewStatus);
    const logger = new RunLogger(stamp("replay"), new Redactor(), EVIDENCE_DIR);
    const driver = new PlaywrightDriver(policy, logger, { headed: o.headed });
    console.log(`replay run ${logger.runId} — ${artifact.capability.id}@${artifact.capability.version} from ${path}`);

    const result = await withOperatorConsole(config, driver, logger, o.console, (gateway) => {
      const engine = new ReplayEngine(artifact, config, driver, logger, {
        secrets: loadSecretsFromEnv(process.env, config.redaction.extraSecretEnvPrefixes),
        env,
        gateway,
      });
      return engine.run(params);
    });

    printResult(result);
    process.exitCode = exitCode(result);
  });

program
  .command("approve")
  .description("Mark a recorded capability as reviewed — required before unattended risky replay")
  .requiredOption("--capability <idOrPath>", "capability id or artifact path")
  .option("--reviewer <name>", "who reviewed it", "operator")
  .action((o) => {
    const { artifact, path } = loadArtifact(o.capability);
    if (artifact.provenance.reviewStatus === "approved") {
      console.log(`${path} is already approved`);
      return;
    }
    const updated = {
      ...artifact,
      provenance: {
        ...artifact.provenance,
        reviewStatus: "approved",
        reviewedBy: o.reviewer,
        reviewedAt: new Date().toISOString(),
      },
    };
    saveArtifact(path, CapabilityArtifactSchema.parse(updated));
    console.log(`approved: ${path} (reviewer: ${o.reviewer})`);
  });

program
  .command("catalog")
  .description("List recorded capabilities and their contracts (what a calling agent reads)")
  .action(() => {
    if (!existsSync(CAPS_DIR)) {
      console.log("no capabilities recorded yet");
      return;
    }
    const files = readdirSync(CAPS_DIR).filter((f) => f.endsWith(".json"));
    if (!files.length) {
      console.log("no capabilities recorded yet");
      return;
    }
    for (const f of files) {
      const a = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(join(CAPS_DIR, f), "utf8")));
      const inputs = a.inputs.map((i) => `${i.name}:${i.type}${i.required ? "" : "?"}`).join(", ") || "(none)";
      const outputs = a.outputs.map((x) => `${x.name}:${x.type}${x.sensitive ? " (sensitive)" : ""}`).join(", ") || "(none)";
      const outcomes = a.outcomes.map((x) => x.code).join(", ") || "(none)";
      console.log(`${a.capability.id}@${a.capability.version} [${a.provenance.reviewStatus}] — ${a.capability.name}`);
      console.log(`  ${a.capability.description}`);
      console.log(`  inputs:   ${inputs}`);
      console.log(`  outputs:  ${outputs}`);
      console.log(`  outcomes: ${outcomes}`);
      console.log(`  policy:   ${a.policy.riskLevel}, unattended=${a.policy.unattendedReplay}, origins=${a.policy.requiredOrigins.join(" ")}`);
      console.log(`  steps:    ${a.steps.length} (${f})`);
    }
  });

program
  .command("health")
  .description("Locator-health report: aggregate per-step strategy-rank telemetry from replay evidence into a drift signal")
  .option("--evidence <dir>", "evidence root to scan", EVIDENCE_DIR)
  .option("--json", "print the raw report as JSON", false)
  .option("--ci", "exit 1 if any capability is drifting or broken", false)
  .action((o) => {
    const runs = collectRunResults(o.evidence);
    const report = buildHealthReport(runs, o.evidence);
    if (o.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const line of renderHealthReport(report)) console.log(line);
    }
    if (o.ci && report.capabilities.some((c) => c.status !== "healthy")) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(2);
});
