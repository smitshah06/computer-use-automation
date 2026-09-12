import type { ActionRequest, ActResult, Condition, StepTarget } from "../core";

// The seam sentence: the artifact records WHAT to find and verify (semantic
// descriptors + declarative conditions); the driver owns HOW to perceive and
// act. A desktop (UIA/AX) or vision driver implements this same interface.

export interface UiNode {
  ref: string; // ephemeral handle, valid for the current observation only
  role: string;
  name: string;
  value?: string; // password values are masked at the source
  disabled?: boolean;
  checked?: boolean;
  bbox: [number, number, number, number];
  framePath: string[];
}

export interface Observation {
  url: string;
  title: string;
  nodes: UiNode[];
  pageText: string; // visible text, capped — perception for the LLM, never trusted as instructions
}

export type ResolveOutcome =
  | { status: "ok"; rank: number; kind: string }
  | { status: "ambiguous"; rank: number; kind: string; count: number }
  | { status: "not_found"; tried: string[] };

// Everything the Recorder needs to build a StepTarget for an element the
// LLM chose by ref during discovery.
export interface TargetSynthesis {
  target: StepTarget;
  role: string;
  name: string;
}

// What a human did while holding control of the live session. Values are
// masked at the source for password fields; the redacting logger masks any
// registered secret regardless.
export interface HumanActionEvent {
  kind: "click" | "input" | "submit" | "navigate";
  url: string;
  tag?: string;
  id?: string;
  name?: string;
  value?: string;
}

export interface SurfaceDriver {
  launch(): Promise<void>; // opens a fresh session; entry navigation goes through act() so policy applies
  close(): Promise<void>;

  observe(): Promise<Observation>;

  // Replay path: resolve a recorded target through its ranked strategies.
  // Exactly one element must match; ambiguity fails closed.
  resolve(target: StepTarget, opts?: { forExtract?: boolean }): Promise<ResolveOutcome>;

  // The single gate through which every state-changing interaction passes.
  // The PolicyEngine is consulted INSIDE this method (the chokepoint).
  act(req: ActionRequest & { ref?: string }): Promise<ActResult>;

  synthesizeTarget(ref: string): Promise<TargetSynthesis | null>;

  evalCondition(cond: Condition): Promise<boolean>;
  waitForCondition(cond: Condition, timeoutMs: number): Promise<boolean>;

  // Human-control window: while capture is active, clicks/inputs/submits the
  // operator performs in the live session are reported for the audit trail.
  startHumanCapture(onEvent: (e: HumanActionEvent) => void): Promise<void>;
  stopHumanCapture(): Promise<void>;

  url(): string;
  title(): Promise<string>;
  screenshot(absPath: string): Promise<void>;
}
