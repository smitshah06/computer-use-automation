import type {
  EscalationGateway,
  InterventionRequest,
  InterventionResolution,
} from "../core";
import type { RunLogger } from "../evidence/run-logger";
import type { HumanActionEvent, SurfaceDriver } from "../surface";
import { RunController } from "./controller";
import { signResolution } from "./signing";
import { InterventionStore, type InterventionRecord } from "./store";

// Only an explicit abort is terminal for CONTROL. A denied approval or an
// expired TTL hands control back to the engine, which decides what the
// disposition means for the RUN (discovery keeps exploring after a deny;
// replay marks the run aborted itself). Treating deny as a control-abort
// would wedge the state machine: the next intervention of a continuing run
// throws "illegal control transition: aborted -> paused".
const TERMINAL_DISPOSITIONS = new Set(["abort"]);

export interface GatewayOptions {
  // HMAC key for signing operator dispositions into tamper-evident audit
  // records. Optional at this seam (unit embeddings); the CLI composition
  // root always supplies one.
  signingSecret?: string;
}

// Orchestrates a control transfer end to end: pause the run, wait for an
// operator, record everything the human does in the live session, and hand
// control back (or mark the run aborted). The engine only ever sees the
// EscalationGateway seam; the console only ever calls claim/resolve.
export class OperatorGateway implements EscalationGateway {
  readonly controller: RunController;
  readonly store: InterventionStore;

  constructor(
    private readonly driver: SurfaceDriver,
    private readonly logger: RunLogger,
    private readonly opts: GatewayOptions = {},
  ) {
    this.controller = new RunController(logger);
    this.store = new InterventionStore(logger);
  }

  async requestIntervention(req: InterventionRequest): Promise<InterventionResolution> {
    this.controller.transition("paused", "system", req.reason);
    const resolution = await this.store.open(req);
    await this.driver.stopHumanCapture().catch(() => {});
    const to = TERMINAL_DISPOSITIONS.has(resolution.disposition) ? "aborted" : "agent";
    this.controller.transition(
      to,
      resolution.operator ?? "system",
      `intervention ${req.id}: ${resolution.disposition}`,
    );
    return resolution;
  }

  // Operator takes the live session. From here until resolve, their actions
  // in the shared browser are captured into evidence as actor "human".
  claim(id: string, operator: string): InterventionRecord {
    const rec = this.store.claim(id, operator);
    this.controller.transition("human", operator, `claimed intervention ${id}`);
    this.driver
      .startHumanCapture((e: HumanActionEvent) => {
        this.logger.log("human", "human_action", { ...e });
      })
      .catch((err: unknown) => {
        // Capture is evidence, not control flow: the handoff still stands,
        // but the gap in the audit trail must itself be on the record.
        this.logger.log("system", "human_capture_failed", {
          interventionId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return rec;
  }

  resolve(id: string, resolution: InterventionResolution): InterventionRecord {
    const secret = this.opts.signingSecret;
    // The chain head is captured while the human still owns the session (the
    // hand-back transition fires only after the parked engine promise
    // resumes), so the signature attests: this operator, holding control
    // under exactly this custody history, chose this disposition.
    return this.store.resolve(
      id,
      resolution,
      secret === undefined
        ? undefined
        : (rec) =>
            signResolution(secret, {
              interventionId: id,
              disposition: resolution.disposition,
              operator: resolution.operator ?? "",
              controlChainHash: this.controller.chainHash,
              resolvedAt: rec.resolvedAt!,
            }),
    );
  }

  close(): void {
    this.store.close();
  }
}
