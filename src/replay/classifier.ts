import type { CapabilityArtifact, Outcome, Recovery, TemplateContext } from "../core";
import type { SurfaceDriver } from "../surface";
import { materializeCondition } from "./materialize";

export type Classification =
  | { type: "outcome"; outcome: Outcome }
  | { type: "recovery"; recovery: Recovery }
  | { type: "none" };

// Strict precedence when the run deviates from the recorded path:
//   1. a declared business outcome — a legitimate answer, never an error
//   2. a declared recovery whose budget is not exhausted
//   3. nothing — the caller must treat this as a hard failure
// Recoveries are checked AFTER outcomes so a recovery can never paper over a
// state the capability's author declared as terminal.
export class DeviationClassifier {
  private uses = new Map<string, number>();

  constructor(
    private readonly artifact: CapabilityArtifact,
    private readonly driver: SurfaceDriver,
    private readonly ctx: TemplateContext,
  ) {}

  async classify(stepId: string): Promise<Classification> {
    for (const o of this.artifact.outcomes) {
      if (await this.driver.evalCondition(materializeCondition(o.detector, this.ctx))) {
        return { type: "outcome", outcome: o };
      }
    }
    for (const r of this.artifact.recoveries) {
      if (r.appliesTo !== "global" && !r.appliesTo.includes(stepId)) continue;
      if ((this.uses.get(r.id) ?? 0) >= r.maxAttempts) continue;
      if (await this.driver.evalCondition(materializeCondition(r.detector, this.ctx))) {
        return { type: "recovery", recovery: r };
      }
    }
    return { type: "none" };
  }

  recordUse(recoveryId: string): void {
    this.uses.set(recoveryId, (this.uses.get(recoveryId) ?? 0) + 1);
  }

  usesOf(recoveryId: string): number {
    return this.uses.get(recoveryId) ?? 0;
  }
}
