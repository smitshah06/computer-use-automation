import { nowIso, type InterventionRequest, type InterventionResolution } from "../core";
import type { RunLogger } from "../evidence/run-logger";
import type { ResolutionSignature } from "./signing";

export interface InterventionRecord {
  request: InterventionRequest;
  status: "pending" | "claimed" | "resolved" | "expired";
  claimedBy?: string;
  claimedAt?: string;
  resolution?: InterventionResolution;
  resolvedAt?: string;
  signature?: ResolutionSignature; // operator dispositions only; TTL expiries have no human to attest
}

// Holds open interventions, parks the engine's promise until an operator (or
// the TTL) resolves it, and persists every state change to interventions.json
// so the run directory is the source of truth even after a crash.
export class InterventionStore {
  private readonly records = new Map<string, InterventionRecord>();
  private readonly waiters = new Map<string, (r: InterventionResolution) => void>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly logger: RunLogger) {}

  open(req: InterventionRequest): Promise<InterventionResolution> {
    if (this.records.has(req.id)) throw new Error(`duplicate intervention id ${req.id}`);
    this.records.set(req.id, { request: req, status: "pending" });
    this.persist();
    const ttlMs = Math.max(0, new Date(req.expiresAt).getTime() - Date.now());
    const timer = setTimeout(() => this.expire(req.id), ttlMs);
    timer.unref();
    this.timers.set(req.id, timer);
    return new Promise<InterventionResolution>((resolve) => this.waiters.set(req.id, resolve));
  }

  list(): InterventionRecord[] {
    return [...this.records.values()];
  }

  get(id: string): InterventionRecord | undefined {
    return this.records.get(id);
  }

  claim(id: string, operator: string): InterventionRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown intervention ${id}`);
    if (rec.status !== "pending") throw new Error(`intervention ${id} is ${rec.status}, not claimable`);
    rec.status = "claimed";
    rec.claimedBy = operator;
    rec.claimedAt = nowIso();
    // The TTL guards *unattended* requests; once a human owns the intervention
    // the clock stops — expiring mid-intervention would yank control away.
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.persist();
    return rec;
  }

  resolve(
    id: string,
    resolution: InterventionResolution,
    sign?: (rec: InterventionRecord) => ResolutionSignature,
  ): InterventionRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown intervention ${id}`);
    if (rec.status === "resolved" || rec.status === "expired") {
      throw new Error(`intervention ${id} already ${rec.status}`);
    }
    // Chain of custody: control must be explicitly taken before it can be
    // handed back — resolving an unclaimed intervention would skip the
    // paused→human transition and leave the audit trail claiming the agent
    // never lost control.
    if (rec.status !== "claimed") {
      throw new Error(`intervention ${id} is ${rec.status}; claim it before resolving`);
    }
    // Custody: the operator who took control is the one accountable for the
    // hand-back. A different (or anonymous) resolver would break the chain.
    if (!resolution.operator || resolution.operator !== rec.claimedBy) {
      throw new Error(
        `intervention ${id} is claimed by "${rec.claimedBy}"; ` +
          `only they can resolve it (got "${resolution.operator ?? "no operator"}")`,
      );
    }
    rec.status = "resolved";
    rec.resolution = resolution;
    rec.resolvedAt = nowIso();
    // Signed after resolvedAt is fixed and before persist, so the stored
    // record and the signed payload agree by construction at write time —
    // any later disagreement IS the tamper evidence.
    if (sign) rec.signature = sign(rec);
    this.settle(id, resolution);
    return rec;
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private expire(id: string): void {
    const rec = this.records.get(id);
    if (!rec || rec.status !== "pending") return;
    rec.status = "expired";
    rec.resolvedAt = nowIso();
    const resolution: InterventionResolution = { disposition: "expired", note: "TTL elapsed" };
    rec.resolution = resolution;
    this.settle(id, resolution);
  }

  private settle(id: string, resolution: InterventionResolution): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.persist();
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.(resolution);
  }

  private persist(): void {
    this.logger.writeJson("interventions.json", this.list());
  }
}
