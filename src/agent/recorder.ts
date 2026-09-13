import { nowIso, parameterizeValue, type ActionKind, type LocatorStrategy, type Risk } from "../core";
import type { TargetSynthesis } from "../surface";

// One successfully executed discovery action, as captured live: the raw value
// still holds template refs ({{secrets.*}} were never resolved into the
// transcript), and the target was synthesized from the element BEFORE the
// action ran (a click may navigate away).
export interface RecordedAct {
  kind: ActionKind;
  intent: string;
  risk: Risk;
  url?: string;
  value?: string;
  key?: string;
  sensitive?: boolean;
  synthesis?: TargetSynthesis;
  outputName?: string;
  outputType?: "string" | "number" | "money" | "date";
  extractPattern?: string;
  urlBefore: string;
  urlAfter: string;
  titleAfter?: string;
}

export interface RecorderSpec {
  capabilityId: string;
  name?: string;
  description?: string;
  appId?: string;
  goal: string;
  entryUrl: string;
  inputs: Record<string, string>;
  sensitiveInputs?: string[];
  env?: Record<string, string>;
  provider: string;
  model: string;
  runId: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

// Distills a recorded run into the capability artifact: parameterizes input
// literals back into {{inputs.*}} (so PII never persists and the artifact is
// reusable), substitutes {{env.*}} for the base URL, derives checkpoints from
// observed navigation, and computes the policy section from what actually ran.
export class Recorder {
  private readonly acts: RecordedAct[] = [];
  private readonly titles: string[] = [];

  constructor(private readonly spec: RecorderSpec) {
    // A typo'd --sensitive-input name would otherwise be silently useless and
    // the value it was meant to protect would persist unmasked. Fail loudly.
    const unknown = (spec.sensitiveInputs ?? []).filter((n) => !(n in spec.inputs));
    if (unknown.length > 0) {
      throw new Error(
        `sensitive input name(s) do not match any declared input: ${unknown.join(", ")} ` +
          `(declared: ${Object.keys(spec.inputs).join(", ") || "none"})`,
      );
    }
  }

  record(a: RecordedAct): void {
    this.acts.push(a);
    if (a.titleAfter) this.titles.push(a.titleAfter);
  }

  get count(): number {
    return this.acts.length;
  }

  // Canonicalize recorded literals back into {{inputs.*}} — exact matches at
  // any length, embedded occurrences only for values >= 4 chars (so a short
  // input like "1" cannot corrupt unrelated text). Redaction and reuse are the
  // same mechanism: an input embedded in a longer recorded string ("member
  // 12345 lookup", "?q=12345") must not persist either.
  private param(text: string): string {
    return parameterizeValue(text, this.spec.inputs);
  }

  // URL parameterization: env base-URL prefix, then input literals in the
  // path and query (whole segments and embedded occurrences)
  private paramUrl(url: string): string {
    let out = url;
    for (const [name, val] of Object.entries(this.spec.env ?? {})) {
      if (val && out.startsWith(val)) out = `{{env.${name}}}` + out.slice(val.length);
    }
    return out
      .split("/")
      .map((seg) => this.param(seg))
      .join("/");
  }

  // Checkpoint regex from an observed URL: escaped pathname with input
  // literals replaced by their template refs, resolved again at replay.
  // Whole-segment matches parameterize at any length; embedded matches only
  // for values >= 4 chars (mirroring parameterizeValue) so a short input like
  // "1" cannot corrupt unrelated path segments such as "/section1".
  private pathRegex(url: string): string {
    const embeddable = Object.entries(this.spec.inputs)
      .filter(([, val]) => Boolean(val) && val.length >= 4)
      .sort((a, b) => b[1].length - a[1].length);
    return pathnameOf(url)
      .split("/")
      .map((seg) => {
        for (const [name, val] of Object.entries(this.spec.inputs)) {
          if (val && seg === val) return `{{inputs.${name}}}`;
        }
        let out = escapeRegex(seg);
        for (const [name, val] of embeddable) {
          out = out.split(escapeRegex(val)).join(`{{inputs.${name}}}`);
        }
        return out;
      })
      .join("/");
  }

  private paramStrategy(s: LocatorStrategy): LocatorStrategy {
    if (s.kind === "role") return s.name ? { ...s, name: this.param(s.name) } : s;
    if (s.kind === "labelText" || s.kind === "nearText") return { ...s, value: this.param(s.value) };
    return s;
  }

  distill(): unknown {
    const spec = this.spec;
    const steps = this.acts.map((a, i) => {
      const id = `s${i + 1}`;
      const step: Record<string, unknown> = { id, intent: a.intent, action: a.kind, risk: a.risk };
      if (a.url) step.url = this.paramUrl(a.url);
      if (a.value !== undefined) step.value = this.param(a.value);
      if (a.key) step.key = a.key;
      if (a.sensitive) step.sensitive = true;
      if (a.synthesis) {
        step.target = {
          ...a.synthesis.target,
          strategies: a.synthesis.target.strategies.map((s) => this.paramStrategy(s)),
        };
      }
      if (a.outputName) step.outputName = a.outputName;
      if (a.extractPattern) step.extractPattern = a.extractPattern;
      if (pathnameOf(a.urlAfter) !== pathnameOf(a.urlBefore)) {
        step.checkpoint = { urlMatches: this.pathRegex(a.urlAfter) };
      }
      return step;
    });

    const outputs = this.acts
      .map((a, i) => ({ a, id: `s${i + 1}` }))
      .filter(({ a }) => a.kind === "extract" && a.outputName)
      .map(({ a, id }) => ({
        name: a.outputName!,
        type: a.outputType ?? "string",
        sensitive: a.sensitive ?? false,
        sourceStep: id,
      }));

    const inputs = Object.entries(spec.inputs).map(([name, val]) => ({
      name,
      type: "string",
      required: true,
      sensitive: spec.sensitiveInputs?.includes(name) ?? false,
      example: spec.sensitiveInputs?.includes(name) ? undefined : val,
      ...(/^\d+$/.test(val) ? { pattern: "^\\d+$" } : {}),
    }));

    const kinds = [...new Set(this.acts.map((a) => a.kind))];
    const anyRisky = this.acts.some((a) => a.risk === "risky");
    const lastUrl = this.acts[this.acts.length - 1]?.urlAfter ?? spec.entryUrl;

    const prefix = this.titles.reduce((p, t) => {
      let i = 0;
      while (i < p.length && i < t.length && p[i] === t[i]) i += 1;
      return p.slice(0, i);
    }, this.titles[0] ?? "");
    const titlePattern = prefix.trim().length >= 4 ? escapeRegex(prefix.trim()) : undefined;

    const artifact = {
      schemaVersion: "1.0",
      capability: {
        id: spec.capabilityId,
        version: "1.0.0",
        name: spec.name ?? spec.capabilityId,
        description: spec.description ?? spec.goal,
      },
      target: {
        appId: spec.appId ?? spec.capabilityId,
        surface: "web",
        entrypoint: this.paramUrl(spec.entryUrl),
        appFingerprint: { ...(titlePattern ? { titlePattern } : {}), markers: [] },
      },
      inputs,
      outputs,
      steps,
      outcomes: [],
      recoveries: [],
      successCheckpoint: { urlMatches: this.pathRegex(lastUrl) },
      policy: {
        requiredOrigins: [new URL(spec.entryUrl).origin],
        allowedActionKinds: kinds,
        riskLevel: anyRisky ? "mutating" : "readonly",
        unattendedReplay: !anyRisky,
      },
      provenance: {
        provider: spec.provider,
        model: spec.model,
        runId: spec.runId,
        recordedAt: nowIso(),
        reviewStatus: "draft",
      },
    };

    // Fail-closed leak scan: parameterization is string surgery, and a
    // sensitive literal could in principle survive it inside a synthesized
    // locator name, derived checkpoint regex, or page-derived text. Refuse to
    // emit such an artifact instead of persisting PII/credentials.
    const sensitiveValues = (spec.sensitiveInputs ?? [])
      .map((n) => spec.inputs[n])
      .filter((v): v is string => Boolean(v));
    if (sensitiveValues.length > 0) {
      const json = JSON.stringify(artifact);
      const leaked = sensitiveValues.some((v) => json.includes(v));
      if (leaked) {
        throw new Error(
          "distill: a sensitive input literal survived parameterization; refusing to write the artifact " +
            "(the flow embeds the value in text the recorder could not safely canonicalize)",
        );
      }
    }
    return artifact;
  }
}
