import {
  describeCondition,
  loadSecretsFromEnv,
  nowIso,
  resolveTemplate,
  sleep,
  type ActionRequest,
  type CapabilityArtifact,
  type Condition,
  type EscalationGateway,
  type InterventionSummary,
  type InterventionType,
  type Outcome,
  type PolicyConfig,
  type Recovery,
  type RunOutcome,
  type RunResult,
  type Step,
  type StepTelemetry,
  type StructuredError,
  type TemplateContext,
} from "../core";
import type { SurfaceDriver } from "../surface";
import type { RunLogger } from "../evidence/run-logger";
import { DeviationClassifier } from "./classifier";
import { materializeCondition, materializeTarget } from "./materialize";

export interface ReplayOptions {
  // Checkpoints are expected to hold almost immediately after an auto-waited
  // action; longer stalls are the declared-recovery system's job (bounded,
  // logged, reviewable) rather than an ever-growing implicit wait.
  checkpointWaitMs?: number;
  gateway?: EscalationGateway;
  secrets?: Record<string, string>;
  env?: Record<string, string>;
}

// Deterministic replay: no LLM anywhere on this code path (the dependency
// checker makes replay/ -> llm/ a build error). Every wait is a declared
// condition with a bounded timeout; every deviation goes through the
// classifier's strict precedence: business outcome > recovery > hard failure.
export class ReplayEngine {
  private readonly checkpointWaitMs: number;
  private ctx!: TemplateContext;
  private classifier!: DeviationClassifier;
  private outputs: Record<string, string> = {};
  private interventions: InterventionSummary[] = [];
  private telemetry: StepTelemetry[] = [];
  private deadline = 0;
  private aborted = false;
  private ivSeq = 0;

  constructor(
    private readonly artifact: CapabilityArtifact,
    private readonly config: PolicyConfig,
    private readonly driver: SurfaceDriver,
    private readonly logger: RunLogger,
    private readonly opts: ReplayOptions = {},
  ) {
    this.checkpointWaitMs = opts.checkpointWaitMs ?? 3000;
  }

  async run(params: Record<string, string>): Promise<RunResult> {
    const startedAt = nowIso();
    const maskedParams = this.maskParams(params);

    const inputErrors = this.validateInputs(params);
    if (inputErrors.length > 0) {
      const result = this.buildResult(startedAt, maskedParams, {
        status: "hard_failure",
        error: {
          expected: "inputs satisfying the capability contract",
          observed: inputErrors.join("; "),
          evidence: [],
        },
      });
      this.logger.writeResult(result);
      return result;
    }

    const secrets =
      this.opts.secrets ?? loadSecretsFromEnv(process.env, this.config.redaction.extraSecretEnvPrefixes);
    this.ctx = { inputs: params, secrets, env: this.opts.env ?? {} };
    for (const v of Object.values(secrets)) this.logger.redactor.register(v);
    for (const inp of this.artifact.inputs) {
      if (inp.sensitive && params[inp.name]) this.logger.redactor.register(params[inp.name]);
    }

    this.classifier = new DeviationClassifier(this.artifact, this.driver, this.ctx);
    this.outputs = {};
    this.interventions = [];
    this.telemetry = [];
    this.aborted = false;
    this.deadline = Date.now() + this.config.budgets.runTimeoutMs;

    this.logger.log("replay", "run_start", {
      capabilityId: this.artifact.capability.id,
      capabilityVersion: this.artifact.capability.version,
      params: maskedParams,
      reviewStatus: this.artifact.provenance.reviewStatus,
    });

    await this.driver.launch();
    let outcome: RunOutcome;
    try {
      outcome = (await this.enter()) ?? (await this.runSteps()) ?? (await this.verifySuccess());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outcome = {
        status: "hard_failure",
        error: await this.captureError("run", undefined, "replay to proceed without unhandled errors", msg),
      };
    } finally {
      await this.driver.close().catch(() => {});
    }

    const result = this.buildResult(startedAt, maskedParams, this.finalize(outcome));
    this.logger.writeResult(result);
    this.logger.writeJson("artifact.json", this.artifact);
    this.logger.log("replay", "run_finished", { status: result.result.status });
    return result;
  }

  // --- entry ----------------------------------------------------------------

  private async enter(): Promise<RunOutcome | undefined> {
    const entry = resolveTemplate(this.artifact.target.entrypoint, this.ctx);
    const res = await this.driver.act({
      kind: "navigate",
      url: entry,
      risk: "safe",
      phase: "replay",
      intent: "open the capability entrypoint",
    });
    if (!res.ok) {
      return {
        status: "hard_failure",
        error: await this.captureError(
          "entry",
          undefined,
          `navigate to entrypoint ${entry}`,
          res.denied ?? res.error ?? "navigation failed",
        ),
      };
    }

    // Fail fast on the wrong app or version before touching anything.
    const fp = this.artifact.target.appFingerprint;
    if (fp.titlePattern && !new RegExp(fp.titlePattern).test(await this.driver.title())) {
      return {
        status: "hard_failure",
        error: await this.captureError(
          "entry",
          undefined,
          `app fingerprint title ~ /${fp.titlePattern}/`,
          `title "${await this.driver.title()}" does not match`,
        ),
      };
    }
    for (const marker of fp.markers) {
      if (!(await this.driver.evalCondition({ textPresent: marker }))) {
        return {
          status: "hard_failure",
          error: await this.captureError(
            "entry",
            undefined,
            `app fingerprint marker "${marker}" present at entrypoint`,
            "marker not found",
          ),
        };
      }
    }
    this.logger.log("replay", "fingerprint_ok", { entrypoint: entry });
    return undefined;
  }

  // --- step loop --------------------------------------------------------------

  private async runSteps(): Promise<RunOutcome | undefined> {
    for (const step of this.artifact.steps) {
      const outcome = await this.runStep(step);
      if (outcome) return outcome;
    }
    return undefined;
  }

  // The success checkpoint gets the same deviation precedence as any step:
  // declared outcome > declared recovery (bounded by maxAttempts, re-verify
  // after each) > assist escalation if a gateway is wired > hard failure.
  private async verifySuccess(): Promise<RunOutcome> {
    const cond = materializeCondition(this.artifact.successCheckpoint, this.ctx);
    const expected = describeCondition(this.artifact.successCheckpoint);
    const lastStep = this.artifact.steps[this.artifact.steps.length - 1]!;
    const recoveriesApplied: string[] = [];
    for (;;) {
      if (await this.driver.waitForCondition(cond, this.checkpointWaitMs)) {
        return this.succeed();
      }
      if (Date.now() > this.deadline) {
        return {
          status: "hard_failure",
          error: await this.captureError("success", undefined, expected, "run timeout exceeded"),
        };
      }
      const c = await this.classifier.classify(lastStep.id);
      if (c.type === "outcome") return this.businessOutcome(lastStep.id, c.outcome);
      if (c.type === "recovery") {
        if (!(await this.applyRecovery(c.recovery, lastStep, recoveriesApplied))) {
          return {
            status: "hard_failure",
            error: await this.captureError("success", undefined, `recovery ${c.recovery.id} to succeed`, "recovery action failed"),
          };
        }
        continue; // re-verify the checkpoint after the recovery
      }
      if (this.opts.gateway) {
        const summary = await this.escalate("assist", `success checkpoint — expected: ${expected}`);
        if (summary.disposition === "completed_step") {
          if (await this.driver.waitForCondition(cond, this.checkpointWaitMs)) {
            this.logger.log("operator", "step_completed_by_human", { stepId: "success" });
            return this.succeed();
          }
          return {
            status: "hard_failure",
            error: await this.captureError(
              "success",
              undefined,
              expected,
              "operator marked the run complete but the success checkpoint still fails",
            ),
          };
        }
        if (summary.disposition === "fixed_environment") continue;
        this.aborted = true;
        return {
          status: "hard_failure",
          error: await this.captureError("success", undefined, expected, `operator disposition: ${summary.disposition}`),
        };
      }
      return {
        status: "hard_failure",
        error: await this.captureError("success", undefined, expected, "success checkpoint not satisfied after all steps"),
      };
    }
  }

  // "Success" is a contract claim, not just a checkpoint: a run whose success
  // checkpoint holds but whose declared outputs were never extracted (an
  // operator hand-back that skipped an extract step, say) must not present
  // itself to the calling agent as a success with silently-missing fields.
  private async succeed(): Promise<RunOutcome> {
    const missing = this.artifact.outputs.map((o) => o.name).filter((n) => this.outputs[n] === undefined);
    if (missing.length > 0) {
      return {
        status: "hard_failure",
        error: await this.captureError(
          "success",
          undefined,
          `all declared outputs populated (${this.artifact.outputs.map((o) => o.name).join(", ")})`,
          `success checkpoint holds but output(s) were never extracted: ${missing.join(", ")}`,
        ),
      };
    }
    this.logger.log("replay", "success_checkpoint_ok", {});
    return { status: "success", outputs: this.outputs };
  }

  private async runStep(step: Step): Promise<RunOutcome | undefined> {
    const t0 = Date.now();
    let attempts = 0;
    const recoveriesApplied: string[] = [];
    let rank: number | null = null;
    let kind: string | undefined;
    let approved = false;
    this.logger.log("replay", "step_start", { stepId: step.id, intent: step.intent, action: step.action });

    const done = (): undefined => {
      this.telemetry.push({
        stepId: step.id,
        strategyRank: rank,
        strategyKind: kind,
        attempts: Math.max(attempts, 1),
        recoveriesApplied,
        durationMs: Date.now() - t0,
      });
      this.logger.log("replay", "step_done", {
        stepId: step.id,
        strategyRank: rank,
        strategyKind: kind,
        attempts,
        recoveriesApplied,
      });
      return undefined;
    };

    for (;;) {
      if (Date.now() > this.deadline) {
        return this.hardFailure(step, "run to finish within the configured budget", "run timeout exceeded");
      }

      // Guard scan: a declared outcome or a known obstacle (interstitial,
      // expired session) can surface BETWEEN steps; detect it before acting
      // on a page that is not the one the step was recorded against.
      const guard = await this.classifier.classify(step.id);
      if (guard.type === "outcome") return this.businessOutcome(step.id, guard.outcome);
      if (guard.type === "recovery") {
        if (!(await this.applyRecovery(guard.recovery, step, recoveriesApplied))) {
          return this.hardFailure(step, `recovery ${guard.recovery.id} to succeed`, "recovery action failed");
        }
        continue;
      }

      if (step.waitBefore) {
        const cond = materializeCondition(step.waitBefore.condition, this.ctx);
        if (!(await this.driver.waitForCondition(cond, step.waitBefore.timeoutMs))) {
          // A readiness hint, not a postcondition: log and attempt anyway —
          // the act's own resolution and the checkpoint are the authority.
          this.logger.log("replay", "wait_before_timeout", {
            stepId: step.id,
            condition: describeCondition(step.waitBefore.condition),
          });
        }
      }

      attempts += 1;
      const res = await this.driver.act(this.buildRequest(step, approved));

      if (res.ok) {
        rank = res.strategyRank ?? null;
        kind = res.strategyKind;
        if (step.action === "extract" && step.outputName && res.extracted !== undefined) {
          this.outputs[step.outputName] = res.extracted;
        }
        if (step.checkpoint) {
          const cond = materializeCondition(step.checkpoint, this.ctx);
          if (!(await this.driver.waitForCondition(cond, this.checkpointWaitMs))) {
            const dev = await this.deviate(step, describeCondition(step.checkpoint), "checkpoint not satisfied", {
              attempts,
              recoveriesApplied,
              checkpoint: cond,
            });
            if (dev === "retry" || dev === "retry_reset") {
              if (dev === "retry_reset") {
                attempts = 0;
                approved = false; // approve_once covers one attempt context, not the post-fix retry
              }
              continue;
            }
            if (dev === "done") return done();
            return dev;
          }
        }
        await this.shot(`${step.id}_ok`);
        return done();
      }

      // --- the act itself failed ---
      if (res.denied) {
        return this.hardFailure(step, "action permitted by policy", `denied by policy: ${res.denied}`);
      }
      if (res.needsApproval) {
        if (!this.opts.gateway) {
          return this.hardFailure(
            step,
            "approval to proceed with a risky action",
            `${res.needsApproval} — no escalation gateway is wired ` +
              "(re-run with the operator console enabled, or approve the capability for unattended replay)",
          );
        }
        const summary = await this.escalate("approval", res.needsApproval, step);
        if (summary.disposition === "approve_once") {
          approved = true;
          attempts -= 1; // the approval round-trip is not a failed attempt
          continue;
        }
        this.aborted = true;
        return this.hardFailure(
          step,
          "approval to proceed with a risky action",
          `operator disposition: ${summary.disposition}`,
        );
      }
      const detail = res.ambiguous
        ? (res.error ?? "ambiguous resolution")
        : res.notFound
          ? (res.error ?? "target not found")
          : (res.error ?? "action failed");
      const dev = await this.deviate(step, `${step.action} on "${step.target?.elementDescription ?? step.url ?? step.key}"`, detail, {
        attempts,
        recoveriesApplied,
        checkpoint: step.checkpoint ? materializeCondition(step.checkpoint, this.ctx) : undefined,
      });
      if (dev === "retry" || dev === "retry_reset") {
        if (dev === "retry_reset") {
          attempts = 0;
          approved = false; // approve_once covers one attempt context, not the post-fix retry
        }
        continue;
      }
      if (dev === "done") return done();
      return dev;
    }
  }

  // Shared deviation pipeline for both act failures and checkpoint failures.
  // Returns "retry" (re-attempt the step), "retry_reset" (operator fixed the
  // environment — re-attempt with a fresh attempt budget), "done" (recovery
  // satisfied the step's postcondition), or a terminal RunOutcome.
  private async deviate(
    step: Step,
    expected: string,
    observed: string,
    state: { attempts: number; recoveriesApplied: string[]; checkpoint?: Condition },
  ): Promise<"retry" | "retry_reset" | "done" | RunOutcome> {
    const c = await this.classifier.classify(step.id);
    if (c.type === "outcome") return this.businessOutcome(step.id, c.outcome);

    if (c.type === "recovery") {
      if (!(await this.applyRecovery(c.recovery, step, state.recoveriesApplied))) {
        return this.hardFailure(step, `recovery ${c.recovery.id} to succeed`, "recovery action failed");
      }
      // Checkpoint-first: if the recovery restored the step's postcondition
      // (slow page finished, re-auth landed back on the expected screen),
      // re-acting would double-apply the step.
      if (state.checkpoint && (await this.driver.waitForCondition(state.checkpoint, this.checkpointWaitMs))) {
        return "done";
      }
      if (state.attempts >= this.config.budgets.maxStepAttempts) {
        return this.hardFailure(
          step,
          expected,
          `${observed} (after ${state.attempts} attempts and recoveries: ${state.recoveriesApplied.join(", ")})`,
        );
      }
      return "retry";
    }

    // Unclassified deviation: hard failure — but if an escalation gateway is
    // wired, a human gets the live session before the run is written off.
    if (this.opts.gateway) {
      const summary = await this.escalate("assist", `${expected} — observed: ${observed}`, step);
      if (summary.disposition === "completed_step") {
        if (!state.checkpoint || (await this.driver.waitForCondition(state.checkpoint, this.checkpointWaitMs))) {
          this.logger.log("operator", "step_completed_by_human", { stepId: step.id });
          return "done";
        }
        return this.hardFailure(step, expected, "operator marked the step complete but its checkpoint still fails");
      }
      if (summary.disposition === "fixed_environment") {
        // Checkpoint-first, exactly like declared recoveries: if the
        // operator's fix already restored the step's postcondition,
        // re-acting would double-apply the step.
        if (state.checkpoint && (await this.driver.waitForCondition(state.checkpoint, this.checkpointWaitMs))) {
          this.logger.log("replay", "checkpoint_ok_after_fix", { stepId: step.id });
          return "done";
        }
        return "retry_reset";
      }
      this.aborted = true;
      return this.hardFailure(step, expected, `operator disposition: ${summary.disposition}`);
    }
    return this.hardFailure(step, expected, observed);
  }

  // --- recoveries -------------------------------------------------------------

  private async applyRecovery(r: Recovery, step: Step, applied: string[]): Promise<boolean> {
    this.classifier.recordUse(r.id);
    applied.push(r.id);
    this.logger.log("replay", "recovery_applied", {
      recoveryId: r.id,
      stepId: step.id,
      action: r.action.kind,
      use: this.classifier.usesOf(r.id),
    });
    switch (r.action.kind) {
      case "dismiss": {
        const res = await this.driver.act({
          kind: "click",
          target: materializeTarget(r.action.target, this.ctx),
          risk: "safe",
          phase: "recovery",
          intent: `dismiss obstacle via recovery ${r.id}`,
        });
        return res.ok;
      }
      case "waitRetry": {
        await sleep(r.action.backoffMs);
        return true;
      }
      case "runSteps": {
        for (const sid of r.action.stepIds) {
          const s = this.artifact.steps.find((x) => x.id === sid)!;
          const res = await this.driver.act(this.buildRequest(s, false, "recovery"));
          if (!res.ok) {
            this.logger.log("replay", "recovery_step_failed", { recoveryId: r.id, stepId: sid, error: res.error });
            return false;
          }
          if (s.checkpoint) {
            const cond = materializeCondition(s.checkpoint, this.ctx);
            if (!(await this.driver.waitForCondition(cond, this.checkpointWaitMs))) {
              this.logger.log("replay", "recovery_step_failed", { recoveryId: r.id, stepId: sid, error: "checkpoint" });
              return false;
            }
          }
        }
        return true;
      }
    }
  }

  // --- escalation --------------------------------------------------------------

  private async escalate(type: InterventionType, reason: string, step?: Step): Promise<InterventionSummary> {
    this.ivSeq += 1;
    const id = `iv_${this.logger.runId}_${this.ivSeq}`;
    const shot = this.logger.nextScreenshotPath(`${step?.id ?? "run"}_intervention`);
    await this.driver.screenshot(shot.abs).catch(() => {});
    const request = {
      id,
      runId: this.logger.runId,
      type,
      capabilityId: this.artifact.capability.id,
      reason,
      stepId: step?.id,
      intent: step?.intent,
      currentUrl: this.driver.url(),
      screenshotPath: shot.rel,
      requestedAt: nowIso(),
      expiresAt: new Date(Date.now() + this.config.escalation.interventionTtlMinutes * 60_000).toISOString(),
    };
    this.logger.log("system", "intervention_requested", { request });
    const resolution = await this.opts.gateway!.requestIntervention(request);
    this.logger.log("operator", "intervention_resolved", {
      id,
      disposition: resolution.disposition,
      operator: resolution.operator,
      note: resolution.note,
    });
    const summary: InterventionSummary = {
      id,
      reason,
      type,
      disposition: resolution.disposition,
      ...(resolution.operator ? { operator: resolution.operator } : {}),
    };
    this.interventions.push(summary);
    return summary;
  }

  // --- terminal outcomes --------------------------------------------------------

  private businessOutcome(stepId: string, outcome: Outcome): RunOutcome {
    this.logger.log("replay", "business_outcome", { stepId, code: outcome.code });
    void this.shot(`${stepId}_outcome_${outcome.code}`);
    return {
      status: "business_outcome",
      code: outcome.code,
      description: outcome.description,
      extracted: { ...this.outputs },
    };
  }

  private async hardFailure(step: Step, expected: string, observed: string): Promise<RunOutcome> {
    return {
      status: "hard_failure",
      error: await this.captureError(step.id, step.intent, expected, observed),
    };
  }

  private async captureError(
    scope: string,
    intent: string | undefined,
    expected: string,
    observed: string,
  ): Promise<StructuredError> {
    const evidence: string[] = [];
    try {
      const shot = this.logger.nextScreenshotPath(`${scope}_failed`);
      await this.driver.screenshot(shot.abs);
      evidence.push(shot.rel);
    } catch {
      // browser may already be gone
    }
    let observedFull = observed;
    try {
      const obs = await this.driver.observe();
      const dumpName = `failure_${scope}.json`;
      this.logger.writeJson(dumpName, obs);
      evidence.push(dumpName);
      observedFull = `${observed} [url=${obs.url} title="${obs.title}"]`;
    } catch {
      // observation is best-effort evidence
    }
    const error: StructuredError = {
      stepId: scope.startsWith("s") && /^s\d+$/.test(scope) ? scope : undefined,
      intent,
      expected,
      observed: observedFull,
      evidence,
    };
    this.logger.log("replay", "hard_failure", { ...error });
    return error;
  }

  private finalize(outcome: RunOutcome): RunOutcome {
    if (this.interventions.length === 0) return outcome;
    const finalStatus =
      outcome.status === "success"
        ? "success"
        : outcome.status === "business_outcome"
          ? "business_outcome"
          : this.aborted
            ? "aborted"
            : "hard_failure";
    return {
      status: "escalated",
      interventions: this.interventions,
      finalStatus,
      outputs: outcome.status === "success" ? outcome.outputs : undefined,
      code: outcome.status === "business_outcome" ? outcome.code : undefined,
      error: outcome.status === "hard_failure" ? outcome.error : undefined,
    };
  }

  // --- helpers -------------------------------------------------------------------

  private buildRequest(step: Step, approved: boolean, phase: "replay" | "recovery" = "replay"): ActionRequest {
    const sensitive =
      step.sensitive ||
      (step.outputName !== undefined &&
        (this.artifact.outputs.find((o) => o.name === step.outputName)?.sensitive ?? false));
    return {
      kind: step.action,
      target: step.target ? materializeTarget(step.target, this.ctx) : undefined,
      url: step.url ? resolveTemplate(step.url, this.ctx) : undefined,
      value: step.value !== undefined ? resolveTemplate(step.value, this.ctx) : undefined,
      key: step.key,
      sensitive,
      extractPattern: step.extractPattern,
      risk: step.risk,
      phase,
      approved: approved || undefined,
      stepId: step.id,
      intent: step.intent,
    };
  }

  private validateInputs(params: Record<string, string>): string[] {
    const errors: string[] = [];
    const known = new Set(this.artifact.inputs.map((i) => i.name));
    for (const k of Object.keys(params)) {
      if (!known.has(k)) errors.push(`unknown input "${k}"`);
    }
    for (const inp of this.artifact.inputs) {
      const v = params[inp.name];
      if (v === undefined) {
        if (inp.required) errors.push(`missing required input "${inp.name}"`);
        continue;
      }
      if (inp.pattern && !new RegExp(inp.pattern).test(v)) {
        errors.push(`input "${inp.name}" does not match /${inp.pattern}/`);
      }
      if (inp.enumValues && !inp.enumValues.includes(v)) {
        errors.push(`input "${inp.name}" must be one of ${inp.enumValues.join(", ")}`);
      }
    }
    return errors;
  }

  private maskParams(params: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    const sensitiveNames = new Set(this.artifact.inputs.filter((i) => i.sensitive).map((i) => i.name));
    for (const [k, v] of Object.entries(params)) {
      out[k] = sensitiveNames.has(k) ? this.config.redaction.maskReplacement : v;
    }
    return out;
  }

  private buildResult(startedAt: string, maskedParams: Record<string, string>, result: RunOutcome): RunResult {
    return {
      runId: this.logger.runId,
      mode: "replay",
      capabilityId: this.artifact.capability.id,
      capabilityVersion: this.artifact.capability.version,
      params: maskedParams,
      startedAt,
      finishedAt: nowIso(),
      result,
      telemetry: this.telemetry,
      evidenceDir: this.logger.runDir,
    };
  }

  private async shot(label: string): Promise<void> {
    try {
      const p = this.logger.nextScreenshotPath(label);
      await this.driver.screenshot(p.abs);
    } catch {
      // screenshots are evidence, not control flow
    }
  }
}
