import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { nowIso, type RunResult } from "../core";
import { Redactor } from "./redactor";

export type Actor = "agent" | "replay" | "human" | "operator" | "system";

// One directory per run: run.jsonl (structured, redacted event log),
// screenshots/, result.json, artifact.json. This is the evidence a reviewer
// replays a run's history from.
export class RunLogger {
  readonly runDir: string;
  readonly screenshotsDir: string;
  private seq = 0;
  private shotSeq = 0;

  constructor(
    readonly runId: string,
    readonly redactor: Redactor,
    baseDir = "evidence",
  ) {
    this.runDir = join(baseDir, runId);
    this.screenshotsDir = join(this.runDir, "screenshots");
    mkdirSync(this.screenshotsDir, { recursive: true });
  }

  log(actor: Actor, type: string, data: Record<string, unknown> = {}): void {
    this.seq += 1;
    // The envelope fields are the audit trail's spine: a payload that happens
    // to carry its own `type`/`actor`/... must not overwrite them (an
    // InterventionRequest, for example, has a `type` of its own). Colliding
    // payload keys are kept, suffixed with "_".
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      payload[k === "seq" || k === "ts" || k === "actor" || k === "type" ? `${k}_` : k] = v;
    }
    const entry = this.redactor.maskDeep({ seq: this.seq, ts: nowIso(), actor, type, ...payload });
    appendFileSync(join(this.runDir, "run.jsonl"), JSON.stringify(entry) + "\n");
  }

  nextScreenshotPath(label: string): { abs: string; rel: string } {
    this.shotSeq += 1;
    const name = `${String(this.shotSeq).padStart(3, "0")}_${label.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40)}.png`;
    const abs = join(this.screenshotsDir, name);
    return { abs, rel: relative(this.runDir, abs) };
  }

  writeResult(result: RunResult): string {
    const path = join(this.runDir, "result.json");
    writeFileSync(path, JSON.stringify(this.redactor.maskDeep(result), null, 2) + "\n");
    return path;
  }

  writeJson(name: string, value: unknown): string {
    const path = join(this.runDir, name);
    writeFileSync(path, JSON.stringify(this.redactor.maskDeep(value), null, 2) + "\n");
    return path;
  }
}
