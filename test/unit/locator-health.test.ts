import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHealthReport, collectRunResults, renderHealthReport } from "../../src/evidence/locator-health";
import type { RunResult, StepTelemetry } from "../../src/core";

let seq = 0;
function mkRun(
  capabilityId: string,
  startedAt: string,
  telemetry: Array<Partial<StepTelemetry> & { stepId: string }>,
  mode: "replay" | "discovery" = "replay",
): RunResult {
  seq += 1;
  return {
    runId: `run_${seq}`,
    mode,
    capabilityId,
    capabilityVersion: "1.0.1",
    params: {},
    startedAt,
    finishedAt: startedAt,
    result: { status: "success", outputs: {} },
    telemetry: telemetry.map((t) => ({
      stepId: t.stepId,
      strategyRank: t.strategyRank ?? null,
      strategyKind: t.strategyKind,
      attempts: t.attempts ?? 1,
      recoveriesApplied: t.recoveriesApplied ?? [],
      durationMs: t.durationMs ?? 10,
    })),
    evidenceDir: `/tmp/${seq}`,
  };
}

const T1 = "2026-09-10T10:00:00.000Z";
const T2 = "2026-09-11T10:00:00.000Z";
const T3 = "2026-09-12T10:00:00.000Z";

describe("buildHealthReport", () => {
  it("flags a step that fell from its primary strategy as drifting", () => {
    const report = buildHealthReport(
      [
        mkRun("standing", T1, [
          { stepId: "s1" }, // navigate: rank stays null in every run — not rankable
          { stepId: "s8", strategyRank: 0, strategyKind: "role" },
          { stepId: "s9", strategyRank: 0, strategyKind: "nearText" },
        ]),
        mkRun("standing", T2, [
          { stepId: "s1" },
          { stepId: "s8", strategyRank: 1, strategyKind: "nearText", recoveriesApplied: ["transient-slow-load"] },
          { stepId: "s9", strategyRank: 0, strategyKind: "nearText" },
        ]),
      ],
      "evroot",
    );

    expect(report.replayRuns).toBe(2);
    const cap = report.capabilities.find((c) => c.capabilityId === "standing")!;
    expect(cap.status).toBe("drifting");
    expect(cap.recoveryCounts).toEqual({ "transient-slow-load": 1 });

    const ids = cap.steps.map((s) => s.stepId);
    expect(ids).toEqual(["s8", "s9"]); // s1 never ranked → excluded

    const s8 = cap.steps.find((s) => s.stepId === "s8")!;
    expect(s8.status).toBe("drifting");
    expect(s8.baseline).toEqual({ rank: 0, kind: "role" });
    expect(s8.latest).toEqual({ rank: 1, kind: "nearText" });
    expect(s8.distribution).toEqual({ "0": 1, "1": 1 });
    expect(s8.note).toMatch(/fell from rank 0 \(role\) to rank 1 \(nearText\)/);

    expect(cap.steps.find((s) => s.stepId === "s9")!.status).toBe("healthy");
  });

  it("flags a step whose latest attempt no longer resolves as broken, and sorts worst-first", () => {
    const report = buildHealthReport(
      [
        mkRun("opener", T1, [{ stepId: "s3", strategyRank: 0, strategyKind: "role" }]),
        mkRun("opener", T2, [{ stepId: "s3", strategyRank: null }]),
        mkRun("healthy-cap", T3, [{ stepId: "s2", strategyRank: 0, strategyKind: "role" }]),
      ],
      "evroot",
    );

    const opener = report.capabilities.find((c) => c.capabilityId === "opener")!;
    expect(opener.status).toBe("broken");
    const s3 = opener.steps[0]!;
    expect(s3.status).toBe("broken");
    expect(s3.latest).toBeNull();
    expect(s3.distribution).toEqual({ "0": 1, none: 1 });

    // worst status first, so the report leads with what needs attention
    expect(report.capabilities.map((c) => c.capabilityId)).toEqual(["opener", "healthy-cap"]);
    expect(report.capabilities[1]!.status).toBe("healthy");
  });

  it("treats a persistent fallback rank as drifting even without a fall", () => {
    const report = buildHealthReport(
      [mkRun("cap", T1, [{ stepId: "s6", strategyRank: 2, strategyKind: "nearText" }])],
      "evroot",
    );
    const s6 = report.capabilities[0]!.steps[0]!;
    expect(s6.status).toBe("drifting");
    expect(s6.note).toMatch(/since the first recorded run/);
  });
});

describe("collectRunResults", () => {
  it("scans only valid replay result.json files and sorts by start time", () => {
    const root = mkdtempSync(join(tmpdir(), "scribe-health-"));

    const put = (dir: string, content: unknown): void => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "result.json"), JSON.stringify(content));
    };
    put("replay_b", mkRun("cap", T2, [{ stepId: "s2", strategyRank: 0, strategyKind: "role" }]));
    put("replay_a", mkRun("cap", T1, [{ stepId: "s2", strategyRank: 0, strategyKind: "role" }]));
    put("disc_x", mkRun("cap", T3, [{ stepId: "s2", strategyRank: 0 }], "discovery")); // wrong mode
    put("junk", { nope: true }); // schema-invalid
    mkdirSync(join(root, "no-result")); // no result.json at all
    writeFileSync(join(root, "not-a-dir.txt"), "x");
    mkdirSync(join(root, "corrupt"));
    writeFileSync(join(root, "corrupt", "result.json"), "{not json");

    const runs = collectRunResults(root);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.startedAt)).toEqual([T1, T2]); // sorted ascending
  });

  it("returns empty for a missing evidence root", () => {
    expect(collectRunResults("/definitely/not/here")).toEqual([]);
  });
});

describe("renderHealthReport", () => {
  it("prints drift rows with notes and a per-capability status line", () => {
    const report = buildHealthReport(
      [
        mkRun("standing", T1, [{ stepId: "s8", strategyRank: 0, strategyKind: "role" }]),
        mkRun("standing", T2, [{ stepId: "s8", strategyRank: 1, strategyKind: "nearText" }]),
      ],
      "evidence",
    );
    const text = renderHealthReport(report).join("\n");
    expect(text).toContain("status: DRIFTING");
    expect(text).toContain("s8");
    expect(text).toContain("fell from rank 0 (role) to rank 1 (nearText)");
  });
});
