import { createHash } from "node:crypto";
import type { RunLogger } from "../evidence/run-logger";

// Who owns the live session right now. Exactly one owner at a time; every
// transfer is validated against the legal edges and logged, so the evidence
// trail shows an auditable chain of custody for the browser.
export type ControlOwner = "agent" | "paused" | "human" | "aborted";

const LEGAL: Record<ControlOwner, readonly ControlOwner[]> = {
  agent: ["paused"],
  paused: ["human", "agent", "aborted"],
  human: ["agent", "aborted"],
  aborted: [],
};

export class RunController {
  private owner: ControlOwner = "agent";
  // Tamper-evident chain over the custody trail: each transition's hash
  // commits to the previous head, so editing any historical
  // control_transition event in run.jsonl breaks every hash after it.
  // Resolution signatures embed the chain head at hand-back, binding "who
  // approved what" to the exact custody history it happened under.
  private chain: string;

  constructor(private readonly logger: RunLogger) {
    // Genesis committed to the runId: two runs with identical custody
    // histories still produce distinct chain heads, so a head (or signature
    // embedding one) copied from another run can never line up.
    this.chain = createHash("sha256").update(`scribe.control-chain.v1:${logger.runId}`).digest("hex");
  }

  get current(): ControlOwner {
    return this.owner;
  }

  get chainHash(): string {
    return this.chain;
  }

  transition(to: ControlOwner, by: string, reason: string): void {
    if (!LEGAL[this.owner].includes(to)) {
      throw new Error(`illegal control transition: ${this.owner} -> ${to} (by ${by})`);
    }
    this.chain = createHash("sha256")
      .update(JSON.stringify([this.chain, this.owner, to, by, reason]))
      .digest("hex");
    this.logger.log("system", "control_transition", { from: this.owner, to, by, reason, chainHash: this.chain });
    this.owner = to;
  }
}
