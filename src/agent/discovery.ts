import {
  CapabilityArtifactSchema,
  loadSecretsFromEnv,
  nowIso,
  resolveTemplate,
  sleep,
  type CapabilityArtifact,
  type EscalationGateway,
  type InterventionRequest,
  type Outcome,
  type PolicyConfig,
  type TemplateContext,
} from "../core";
import type { AgentTurn, AssistantDecision, LLMProvider } from "../llm";
import type { Observation, SurfaceDriver, TargetSynthesis } from "../surface";
import type { RunLogger } from "../evidence/run-logger";
import { ActToolSchema, AGENT_TOOLS, DeclareOutcomeSchema, ExtractToolSchema, FinishToolSchema } from "./tools";
import { renderObservation, systemPrompt } from "./prompts";
import { Recorder } from "./recorder";

export interface DiscoverySpec {
  goal: string;
  entryUrl: string;
  capabilityId: string;
  capabilityName?: string;
  description?: string;
  appId?: string;
  inputs: Record<string, string>;
  sensitiveInputs?: string[];
  env?: Record<string, string>;
}

export interface DiscoveryOptions {
  secrets?: Record<string, string>;
  gateway?: EscalationGateway;
  maxTurns?: number;
}

export interface DiscoveryOutput {
  status: "recorded" | "business_outcome" | "stuck";
  summary: string;
  turns: number;
  artifact?: CapabilityArtifact;
  outcome?: Outcome; // declared during the run; the CLI merges it into an existing artifact
}

type ExecOutcome = { result: string } | { terminal: DiscoveryOutput };

// The discovery loop: observe → the model picks exactly one tool → validate →
// execute through the same policy-checked driver replay uses → record. The
// model only ever sees masked perception and template refs; raw secrets are
// resolved locally at act time and never enter the transcript.
export class DiscoveryEngine {
  private readonly recorder: Recorder;
  private readonly system: string;
  private ctx: TemplateContext = { inputs: {}, secrets: {}, env: {} };
  private secretValues: string[] = [];
  private readonly sigCount = new Map<string, number>();
  private readonly outputs: Record<string, string> = {};
  private ivSeq = 0;

  constructor(
    private readonly provider: LLMProvider,
    private readonly config: PolicyConfig,
    private readonly driver: SurfaceDriver,
    private readonly logger: RunLogger,
    private readonly spec: DiscoverySpec,
    private readonly opts: DiscoveryOptions = {},
  ) {
    this.recorder = new Recorder({
      capabilityId: spec.capabilityId,
      name: spec.capabilityName,
      description: spec.description,
      appId: spec.appId,
      goal: spec.goal,
      entryUrl: spec.entryUrl,
      inputs: spec.inputs,
      sensitiveInputs: spec.sensitiveInputs,
      env: spec.env,
      provider: provider.name,
      model: provider.model,
      runId: logger.runId,
    });
    this.system = systemPrompt({
      goal: spec.goal,
      inputs: spec.inputs,
      secretNames: [], // filled in run() once secrets are loaded
      origins: [new URL(spec.entryUrl).origin],
    });
  }

  async run(): Promise<DiscoveryOutput> {
    const secrets = this.opts.secrets ?? loadSecretsFromEnv(process.env, this.config.redaction.extraSecretEnvPrefixes);
    this.ctx = { inputs: this.spec.inputs, secrets, env: this.spec.env ?? {} };
    this.secretValues = Object.values(secrets).filter(Boolean);
    for (const v of this.secretValues) this.logger.redactor.register(v);
    for (const name of this.spec.sensitiveInputs ?? []) {
      const v = this.spec.inputs[name];
      if (v) this.logger.redactor.register(v);
    }
    const system = systemPrompt({
      goal: this.spec.goal,
      inputs: this.spec.inputs,
      secretNames: Object.keys(secrets),
      origins: [new URL(this.spec.entryUrl).origin],
    });

    this.logger.log("agent", "discovery_start", {
      goal: this.spec.goal,
      entryUrl: this.spec.entryUrl,
      capabilityId: this.spec.capabilityId,
      provider: this.provider.name,
      model: this.provider.model,
    });

    await this.driver.launch();
    try {
      return await this.loop(system);
    } finally {
      await this.driver.close();
    }
  }

  private async loop(system: string): Promise<DiscoveryOutput> {
    const entry = await this.driver.act({
      kind: "navigate",
      url: this.spec.entryUrl,
      risk: "safe",
      phase: "discovery",
      intent: "Open the application entrypoint",
      stepId: "d0",
    });
    if (!entry.ok) {
      return {
        status: "stuck",
        summary: `entry navigation failed: ${entry.denied ?? entry.error ?? "unreachable"}`,
        turns: 0,
      };
    }
    this.recorder.record({
      kind: "navigate",
      url: this.spec.entryUrl,
      intent: "Open the application entrypoint",
      risk: "safe",
      urlBefore: "about:blank",
      urlAfter: this.driver.url(),
      titleAfter: await this.driver.title(),
    });

    const turns: AgentTurn[] = [
      { role: "user", content: `Begin. Current state of the application:\n\n${await this.observeMasked()}` },
    ];
    const maxTurns = this.opts.maxTurns ?? this.config.budgets.discoveryMaxTurns;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      let decision: AssistantDecision;
      try {
        decision = await this.decideWithRetry({ system, turns, tools: AGENT_TOOLS });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await this.captureStuck(`LLM provider failed: ${msg}`);
        return { status: "stuck", summary: `LLM provider failed after retries: ${msg}`, turns: turn };
      }
      this.logger.log("agent", "llm_decision", {
        turn,
        tool: decision.toolName,
        input: decision.toolInput,
        text: decision.text,
      });
      turns.push({
        role: "assistant",
        text: decision.text,
        toolName: decision.toolName,
        toolInput: decision.toolInput,
        toolCallId: decision.toolCallId,
      });

      const r = await this.execute(decision, turn);
      if ("terminal" in r) return { ...r.terminal, turns: turn };
      turns.push({ role: "tool", toolCallId: decision.toolCallId, content: r.result });
    }

    await this.captureStuck("turn budget exhausted");
    return {
      status: "stuck",
      summary: `turn budget (${maxTurns}) exhausted before the goal was accomplished`,
      turns: maxTurns,
    };
  }

  private async execute(decision: AssistantDecision, turn: number): Promise<ExecOutcome> {
    switch (decision.toolName) {
      case "act":
        return this.execAct(decision.toolInput, turn);
      case "extract":
        return this.execExtract(decision.toolInput, turn);
      case "declare_outcome":
        return this.execDeclareOutcome(decision.toolInput, turn);
      case "finish":
        return this.execFinish(decision.toolInput);
      default:
        return { result: `unknown tool "${decision.toolName}" — use act, extract, declare_outcome or finish` };
    }
  }

  private async execAct(input: unknown, turn: number): Promise<ExecOutcome> {
    const p = ActToolSchema.safeParse(input);
    if (!p.success) return { result: `invalid act input: ${p.error.issues.map((i) => i.message).join("; ")}` };
    const a = p.data;

    // stuck detection: the same action against the same page state
    const sig = JSON.stringify({ k: a.kind, ref: a.ref, url: a.url, value: a.value, key: a.key, at: this.driver.url() });
    const seen = (this.sigCount.get(sig) ?? 0) + 1;
    this.sigCount.set(sig, seen);
    if (seen >= 4) {
      await this.captureStuck("action loop detected");
      return {
        terminal: {
          status: "stuck",
          summary: `stuck: the same action was attempted ${seen} times without progress (${a.intent})`,
          turns: turn,
        },
      };
    }

    let value: string | undefined;
    let url: string | undefined;
    try {
      value = a.value !== undefined ? resolveTemplate(a.value, this.ctx) : undefined;
      url = a.url !== undefined ? resolveTemplate(a.url, this.ctx) : undefined;
    } catch (e) {
      return { result: `template error: ${(e as Error).message}` };
    }

    // synthesize before acting — a click may navigate away from the element
    let synthesis: TargetSynthesis | undefined;
    if (a.ref) {
      synthesis = (await this.driver.synthesizeTarget(a.ref)) ?? undefined;
      if (!synthesis) {
        return {
          result: `stale or unknown ref "${a.ref}" — refs are only valid for the current observation. Fresh observation:\n\n${await this.observeMasked()}`,
        };
      }
    }

    const sensitive = a.value?.includes("{{secrets.") ?? false;
    const urlBefore = this.driver.url();
    const req = {
      kind: a.kind,
      ref: a.ref,
      url,
      value,
      key: a.key,
      sensitive,
      risk: a.risk,
      phase: "discovery" as const,
      intent: a.intent,
      stepId: `d${turn}`,
    };
    let res = await this.driver.act(req);

    if (res.needsApproval) {
      if (!this.opts.gateway) {
        return {
          result: `policy requires operator approval for this action (${res.needsApproval}) and no operator is available — choose a different path or finish(stuck)`,
        };
      }
      const disposition = await this.requestApproval(res.needsApproval, a.intent);
      if (disposition !== "approve_once") return { result: `operator declined the action (${disposition})` };
      res = await this.driver.act({ ...req, approved: true });
    }
    if (res.denied) return { result: `policy denied: ${res.denied}` };
    if (!res.ok) {
      const why = res.error ?? (res.ambiguous ? "target is ambiguous" : res.notFound ? "target not found" : "failed");
      return { result: `action failed: ${why}` };
    }

    this.recorder.record({
      kind: a.kind,
      intent: a.intent,
      risk: a.risk,
      url: a.url, // raw, template-preserved
      value: a.value,
      key: a.key,
      sensitive,
      synthesis,
      urlBefore,
      urlAfter: this.driver.url(),
      titleAfter: await this.driver.title(),
    });
    const shot = this.logger.nextScreenshotPath(`d${turn}_${a.kind}`);
    await this.driver.screenshot(shot.abs).catch(() => {});

    const stuckHint = seen === 3 ? "\n\nWARNING: you have now performed this exact action 3 times — change approach or finish(stuck)." : "";
    return { result: `ok — action performed.${stuckHint}\n\n${await this.observeMasked()}` };
  }

  private async execExtract(input: unknown, turn: number): Promise<ExecOutcome> {
    const p = ExtractToolSchema.safeParse(input);
    if (!p.success) return { result: `invalid extract input: ${p.error.issues.map((i) => i.message).join("; ")}` };
    const x = p.data;

    const synthesis = (await this.driver.synthesizeTarget(x.ref)) ?? undefined;
    if (!synthesis) {
      return {
        result: `stale or unknown ref "${x.ref}". Fresh observation:\n\n${await this.observeMasked()}`,
      };
    }
    const here = this.driver.url();
    const res = await this.driver.act({
      kind: "extract",
      ref: x.ref,
      sensitive: x.sensitive,
      extractPattern: x.extractPattern,
      risk: "safe",
      phase: "discovery",
      intent: x.intent,
      stepId: `d${turn}`,
    });
    if (!res.ok) return { result: `extract failed: ${res.error ?? "element not readable"}` };

    this.recorder.record({
      kind: "extract",
      intent: x.intent,
      risk: "safe",
      sensitive: x.sensitive,
      synthesis,
      outputName: x.outputName,
      outputType: x.type,
      extractPattern: x.extractPattern,
      urlBefore: here,
      urlAfter: here,
      titleAfter: await this.driver.title(),
    });
    this.outputs[x.outputName] = res.extracted ?? "";
    return { result: `extracted ${x.outputName} = ${x.sensitive ? "***" : (res.extracted ?? "")}` };
  }

  private async execDeclareOutcome(input: unknown, turn: number): Promise<ExecOutcome> {
    const p = DeclareOutcomeSchema.safeParse(input);
    if (!p.success) return { result: `invalid declare_outcome input: ${p.error.issues.map((i) => i.message).join("; ")}` };
    const d = p.data;
    const visible = await this.driver.evalCondition({ textPresent: d.detectorText });
    if (!visible) {
      return { result: `the text "${d.detectorText}" is not visible on the current screen — declare only outcomes you can observe` };
    }
    const outcome: Outcome = { code: d.code, terminal: true, description: d.description, detector: { textPresent: d.detectorText } };
    this.logger.log("agent", "outcome_declared", { code: d.code, description: d.description, detectorText: d.detectorText });
    const shot = this.logger.nextScreenshotPath(`outcome_${d.code}`);
    await this.driver.screenshot(shot.abs).catch(() => {});
    return { terminal: { status: "business_outcome", summary: d.description, outcome, turns: turn } };
  }

  private async execFinish(input: unknown): Promise<ExecOutcome> {
    const p = FinishToolSchema.safeParse(input);
    if (!p.success) return { result: `invalid finish input: ${p.error.issues.map((i) => i.message).join("; ")}` };
    const f = p.data;

    if (f.status === "stuck") {
      await this.captureStuck(f.summary);
      return { terminal: { status: "stuck", summary: f.summary, turns: 0 } };
    }
    if (this.recorder.count <= 1) {
      return { result: "nothing has been recorded beyond the entrypoint — accomplish the goal before finishing" };
    }
    const artifact = CapabilityArtifactSchema.parse(this.recorder.distill());
    this.logger.writeJson("artifact.json", artifact);
    this.logger.log("agent", "discovery_recorded", {
      capabilityId: artifact.capability.id,
      steps: artifact.steps.length,
      outputs: artifact.outputs.map((o) => o.name),
      riskLevel: artifact.policy.riskLevel,
    });
    return { terminal: { status: "recorded", summary: f.summary, artifact, turns: 0 } };
  }

  // Transient provider errors (rate limits, 5xx, network blips) get a bounded
  // retry with backoff; a persistently failing provider ends the run as
  // "stuck" rather than crashing it. Only discovery talks to a model, so this
  // is the only retry-on-LLM in the system.
  private async decideWithRetry(req: {
    system: string;
    turns: AgentTurn[];
    tools: typeof AGENT_TOOLS;
  }): Promise<AssistantDecision> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.provider.decide(req);
      } catch (e) {
        lastErr = e;
        this.logger.log("agent", "llm_call_failed", {
          attempt,
          error: e instanceof Error ? e.message : String(e),
        });
        if (attempt < 3) await sleep(1000 * attempt * attempt); // 1s, 4s
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async requestApproval(reason: string, intent: string): Promise<string> {
    this.ivSeq += 1;
    const id = `iv_${this.logger.runId}_${this.ivSeq}`;
    const shot = this.logger.nextScreenshotPath("discovery_approval");
    await this.driver.screenshot(shot.abs).catch(() => {});
    const request: InterventionRequest = {
      id,
      runId: this.logger.runId,
      type: "approval",
      capabilityId: this.spec.capabilityId,
      reason,
      intent,
      currentUrl: this.driver.url(),
      screenshotPath: shot.rel,
      requestedAt: nowIso(),
      expiresAt: new Date(Date.now() + this.config.escalation.interventionTtlMinutes * 60_000).toISOString(),
    };
    this.logger.log("system", "intervention_requested", { ...request });
    const resolution = await this.opts.gateway!.requestIntervention(request);
    this.logger.log("operator", "intervention_resolved", {
      id,
      disposition: resolution.disposition,
      operator: resolution.operator,
    });
    return resolution.disposition;
  }

  // Perception hygiene: even though passwords are masked at the source, any
  // secret appearing ANYWHERE in the observation — page text, title, node
  // names, node values, even embedded in longer strings (an app echoing a
  // credential back) — is masked before it can enter the model transcript.
  private async observeMasked(): Promise<string> {
    const obs = await this.driver.observe();
    const masked: Observation = {
      ...obs,
      title: this.maskText(obs.title),
      pageText: this.maskText(obs.pageText),
      nodes: obs.nodes.map((n) => {
        const m = { ...n, name: this.maskText(n.name) };
        if (m.value !== undefined) m.value = this.maskText(m.value);
        return m;
      }),
    };
    return renderObservation(masked);
  }

  private maskText(text: string): string {
    let out = text;
    // Longest-first so one secret being a substring of another cannot leak.
    const byLength = [...this.secretValues].sort((a, b) => b.length - a.length);
    for (const v of byLength) out = out.split(v).join("***");
    return out;
  }

  private async captureStuck(reason: string): Promise<void> {
    const shot = this.logger.nextScreenshotPath("discovery_stuck");
    await this.driver.screenshot(shot.abs).catch(() => {});
    const obs = await this.driver.observe().catch(() => undefined);
    if (obs) this.logger.writeJson("failure_discovery.json", obs);
    this.logger.log("agent", "discovery_stuck", { reason, url: this.driver.url() });
  }
}
