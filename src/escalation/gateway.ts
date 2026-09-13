import type {
  EscalationGateway,
  InterventionRequest,
  InterventionResolution,
} from "../core";
import type { RunLogger } from "../evidence/run-logger";
import type { HumanActionEvent, SurfaceDriver } from "../surface";
import { RunController } from "./controller";
import { InterventionStore, type InterventionRecord } from "./store";

const TERMINAL_DISPOSITIONS = new Set(["abort", "deny", "expired"]);

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
    return this.store.resolve(id, resolution);
  }

  close(): void {
    this.store.close();
  }
}
