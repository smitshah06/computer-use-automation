import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RunResultSchema, type RunResult } from "../core";

// ---------------------------------------------------------------------------
// Locator health: replay already records, per step, WHICH strategy rank
// matched (0 = the recorded primary; rising ranks = falling through toward
// css/bbox last resorts). This module aggregates that telemetry across all
// committed replay runs into a drift report — the early-warning signal that a
// capability needs re-validation BEFORE it becomes an outage.
// ---------------------------------------------------------------------------

export interface RankSample {
  rank: number;
  kind: string;
}

export type HealthStatus = "healthy" | "drifting" | "broken";

export interface StepHealth {
  stepId: string;
  runsAttempted: number;
  baseline: RankSample | null; // earliest successful resolution; null = never resolved in the scanned runs
  latest: RankSample | null; // most recent successful resolution; null = latest attempt failed
  worstRank: number | null;
  distribution: Record<string, number>; // rank -> count ("none" = attempted, not resolved)
  status: HealthStatus;
  note: string;
}

export interface CapabilityHealth {
  capabilityId: string;
  versionsSeen: string[];
  runCount: number;
  firstRunAt: string;
  lastRunAt: string;
  status: HealthStatus;
  steps: StepHealth[]; // rankable steps only (targetless steps never rank)
  recoveryCounts: Record<string, number>;
}

export interface HealthReport {
  generatedAt: string;
  evidenceRoot: string;
  replayRuns: number;
  capabilities: CapabilityHealth[];
}

const SEVERITY: Record<HealthStatus, number> = { healthy: 0, drifting: 1, broken: 2 };

// Scan evidence/<run>/result.json files. Only replay runs carry meaningful
// rank telemetry (discovery acts by ephemeral ref, not recorded strategies).
// Unreadable or schema-invalid files are skipped, not fatal: the report must
// work on a mixed evidence directory.
export function collectRunResults(evidenceRoot: string): RunResult[] {
  if (!existsSync(evidenceRoot)) return [];
  const out: RunResult[] = [];
  for (const entry of readdirSync(evidenceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(evidenceRoot, entry.name, "result.json");
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const parsed = RunResultSchema.safeParse(raw);
    if (!parsed.success || parsed.data.mode !== "replay") continue;
    out.push(parsed.data);
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

interface Sample {
  rank: number | null;
  kind?: string;
  targeted?: boolean;
}

function stepHealth(stepId: string, samples: Sample[]): StepHealth | null {
  const resolved = samples.filter((s): s is { rank: number; kind?: string } => s.rank !== null);
  if (resolved.length === 0) {
    // No resolution in any run. Two very different cases: a targetless step
    // (navigate/press) has nothing to rank — but a TARGETED step that never
    // resolved is the worst possible signal, not a reason to drop the row.
    // (Runs recorded before the `targeted` flag existed stay excluded.)
    if (!samples.some((s) => s.targeted === true)) return null;
    return {
      stepId,
      runsAttempted: samples.length,
      baseline: null,
      latest: null,
      worstRank: null,
      distribution: { none: samples.length },
      status: "broken",
      note: "targeted step has never resolved at any strategy rank in the scanned runs",
    };
  }

  const baseline: RankSample = { rank: resolved[0]!.rank, kind: resolved[0]!.kind ?? "?" };
  const latestResolved = resolved[resolved.length - 1]!;
  const latest: RankSample = { rank: latestResolved.rank, kind: latestResolved.kind ?? "?" };
  const lastAttempt = samples[samples.length - 1]!;

  const distribution: Record<string, number> = {};
  for (const s of samples) {
    const key = s.rank === null ? "none" : String(s.rank);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }

  let status: HealthStatus;
  let note: string;
  if (lastAttempt.rank === null) {
    status = "broken";
    note = `historically resolved at rank ${baseline.rank} (${baseline.kind}); the latest attempt failed to resolve at any rank`;
  } else if (lastAttempt.rank > 0) {
    status = "drifting";
    note =
      baseline.rank === lastAttempt.rank
        ? `resolving at fallback rank ${lastAttempt.rank} (${lastAttempt.kind ?? "?"}) since the first recorded run`
        : `fell from rank ${baseline.rank} (${baseline.kind}) to rank ${lastAttempt.rank} (${lastAttempt.kind ?? "?"}) — patch the strategy list or re-validate`;
  } else {
    status = "healthy";
    note =
      baseline.rank > 0
        ? `recovered: rank ${baseline.rank} (${baseline.kind}) historically, primary strategy matching now`
        : "primary strategy matching";
  }

  return {
    stepId,
    runsAttempted: samples.length,
    baseline,
    latest: lastAttempt.rank === null ? null : latest,
    worstRank: Math.max(...resolved.map((s) => s.rank)),
    distribution,
    status,
    note,
  };
}

export function buildHealthReport(runs: RunResult[], evidenceRoot: string): HealthReport {
  const byCap = new Map<string, RunResult[]>();
  for (const r of runs) {
    const list = byCap.get(r.capabilityId) ?? [];
    list.push(r);
    byCap.set(r.capabilityId, list);
  }

  const capabilities: CapabilityHealth[] = [];
  for (const [capabilityId, capRuns] of byCap) {
    // per-step samples in run order; a run contributes only if it attempted the step
    const samplesByStep = new Map<string, Sample[]>();
    const recoveryCounts: Record<string, number> = {};
    for (const run of capRuns) {
      for (const t of run.telemetry) {
        const list = samplesByStep.get(t.stepId) ?? [];
        list.push({ rank: t.strategyRank, kind: t.strategyKind, targeted: t.targeted });
        samplesByStep.set(t.stepId, list);
        for (const rec of t.recoveriesApplied) {
          recoveryCounts[rec] = (recoveryCounts[rec] ?? 0) + 1;
        }
      }
    }

    const steps = [...samplesByStep.entries()]
      .map(([stepId, samples]) => stepHealth(stepId, samples))
      .filter((s): s is StepHealth => s !== null)
      .sort((a, b) => a.stepId.localeCompare(b.stepId, undefined, { numeric: true }));

    const status = steps.reduce<HealthStatus>(
      (worst, s) => (SEVERITY[s.status] > SEVERITY[worst] ? s.status : worst),
      "healthy",
    );

    capabilities.push({
      capabilityId,
      versionsSeen: [...new Set(capRuns.map((r) => r.capabilityVersion))],
      runCount: capRuns.length,
      firstRunAt: capRuns[0]!.startedAt,
      lastRunAt: capRuns[capRuns.length - 1]!.startedAt,
      status,
      steps,
      recoveryCounts,
    });
  }

  capabilities.sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || a.capabilityId.localeCompare(b.capabilityId));
  return {
    generatedAt: new Date().toISOString(),
    evidenceRoot,
    replayRuns: runs.length,
    capabilities,
  };
}

export function renderHealthReport(r: HealthReport): string[] {
  const lines: string[] = [];
  lines.push(`locator health — ${r.evidenceRoot} · ${r.replayRuns} replay runs · ${r.capabilities.length} capabilities`);
  if (r.capabilities.length === 0) {
    lines.push(`no replay result.json files found under ${r.evidenceRoot}/`);
    return lines;
  }
  for (const c of r.capabilities) {
    lines.push("");
    lines.push(
      `${c.capabilityId} ${c.versionsSeen.map((v) => `v${v}`).join(", ")} · runs: ${c.runCount} · ` +
        `${c.firstRunAt.slice(0, 10)} → ${c.lastRunAt.slice(0, 10)} · status: ${c.status.toUpperCase()}`,
    );
    const attention = c.steps.filter((s) => s.status !== "healthy");
    if (attention.length === 0) {
      lines.push(`  no locator drift across ${c.steps.length} rankable steps`);
    } else {
      lines.push(`  step   runs  baseline           latest             seen`);
      for (const s of attention) {
        const baseline = s.baseline === null ? "never" : `${s.baseline.rank} (${s.baseline.kind})`;
        const latest = s.latest === null ? "unresolved" : `${s.latest.rank} (${s.latest.kind})`;
        const seen = Object.entries(s.distribution)
          .map(([k, v]) => `${k}×${v}`)
          .join(" ");
        lines.push(`  ${s.stepId.padEnd(6)} ${String(s.runsAttempted).padEnd(5)} ${baseline.padEnd(18)} ${latest.padEnd(18)} ${seen}`);
        lines.push(`    ↳ ${s.note}`);
      }
    }
    const recs = Object.entries(c.recoveryCounts);
    if (recs.length) {
      lines.push(`  recoveries applied: ${recs.map(([id, n]) => `${id}×${n}`).join(", ")}`);
    }
  }
  return lines;
}
