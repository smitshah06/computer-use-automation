import { nowIso, type InterventionRequest, type InterventionResolution } from "../core";
import type { RunLogger } from "../evidence/run-logger";

export interface InterventionRecord {
  request: InterventionRequest;
  status: "pending" | "claimed" | "resolved" | "expired";
  claimedBy?: string;
  claimedAt?: string;
  resolution?: InterventionResolution;
  resolvedAt?: string;
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
    this.persist();
    return rec;
  }

  resolve(id: string, resolution: InterventionResolution): InterventionRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown intervention ${id}`);
    if (rec.status === "resolved" || rec.status === "expired") {
      throw new Error(`intervention ${id} already ${rec.status}`);
    }
    rec.status = "resolved";
    rec.resolution = resolution;
    rec.resolvedAt = nowIso();
    this.settle(id, resolution);
    return rec;
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private expire(id: string): void {
    const rec = this.records.get(id);
    if (!rec || rec.status === "resolved" || rec.status === "expired") return;
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
