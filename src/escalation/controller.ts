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

  constructor(private readonly logger: RunLogger) {}

  get current(): ControlOwner {
    return this.owner;
  }

  transition(to: ControlOwner, by: string, reason: string): void {
    if (!LEGAL[this.owner].includes(to)) {
      throw new Error(`illegal control transition: ${this.owner} -> ${to} (by ${by})`);
    }
    this.logger.log("system", "control_transition", { from: this.owner, to, by, reason });
    this.owner = to;
  }
}
