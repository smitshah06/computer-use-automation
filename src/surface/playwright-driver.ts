import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright";
import {
  describeStrategy,
  sleep,
  type ActionRequest,
  type ActResult,
  type Condition,
  type LocatorStrategy,
  type StepTarget,
} from "../core";
import type { PolicyEngine } from "../policy/engine";
import type { RunLogger, Actor } from "../evidence/run-logger";
import type {
  HumanActionEvent,
  Observation,
  ResolveOutcome,
  SurfaceDriver,
  TargetSynthesis,
  UiNode,
} from "./types";

export interface DriverOptions {
  headed?: boolean;
  actTimeoutMs?: number;
}

type RawNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  bbox: [number, number, number, number];
};

type PickResult = { status: "ok" } | { status: "none" } | { status: "ambiguous"; count: number };

// ---------------------------------------------------------------------------
// In-page functions. Each is serialized by Playwright and runs in the browser,
// so every helper must be inlined — no references to module scope.
// ---------------------------------------------------------------------------

function snapshotPage(args: { frameIndex: number; textCap: number }): { nodes: RawNode[]; pageText: string } {
  const { frameIndex, textCap } = args;
  document.querySelectorAll("[data-sref]").forEach((el) => el.removeAttribute("data-sref"));

  const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
  const vis = (el: Element): boolean =>
    el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "hidden") return "hidden";
      return "textbox";
    }
    return tag;
  };

  const accName = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const lbBy = el.getAttribute("aria-labelledby");
    if (lbBy) {
      const t = lbBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (clean(t)) return clean(t);
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return clean(lab.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.textContent);
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      const v = (el as HTMLInputElement).value;
      if ((t === "button" || t === "submit" || t === "reset") && v) return clean(v);
    }
    if (tag === "a" || tag === "button" || el.getAttribute("role")) {
      const t = clean(el.textContent);
      if (t) return t.slice(0, 80);
    }
    const ph = el.getAttribute("placeholder");
    if (ph) return clean(ph);
    const ti = el.getAttribute("title");
    if (ti) return clean(ti);
    return "";
  };

  const els = Array.from(
    document.querySelectorAll("a[href], button, input, select, textarea, [role], [onclick]")
  ).filter((el) => vis(el) && (el.getAttribute("type") ?? "").toLowerCase() !== "hidden");

  const nodes: RawNode[] = els.map((el, i) => {
    const ref = `f${frameIndex}e${i}`;
    el.setAttribute("data-sref", ref);
    const r = el.getBoundingClientRect();
    const node: RawNode = {
      ref,
      role: roleOf(el),
      name: accName(el).slice(0, 120),
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    };
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      const v = (el as HTMLInputElement).value ?? "";
      node.value = type === "password" ? (v ? "***" : "") : String(v);
      if (type === "checkbox" || type === "radio") node.checked = (el as HTMLInputElement).checked;
    }
    if ((el as HTMLInputElement).disabled) node.disabled = true;
    return node;
  });

  // Leaf text holders (labels, grid cells, values) join the snapshot as role
  // "text" so an agent can extract data by ref, not just click controls.
  const interactive = new Set(els);
  const ownText = (el: Element): string => {
    let t = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) t += n.textContent ?? "";
    });
    return clean(t);
  };
  let n = els.length;
  const textEls = Array.from(document.querySelectorAll("body *")).filter((el) => {
    if (interactive.has(el)) return false;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE") return false;
    if (el.closest("a[href], button, select, textarea")) return false;
    return vis(el) && ownText(el) !== "";
  });
  for (const el of textEls.slice(0, 150)) {
    const ref = `f${frameIndex}e${n}`;
    n += 1;
    el.setAttribute("data-sref", ref);
    const r = el.getBoundingClientRect();
    nodes.push({
      ref,
      role: "text",
      name: ownText(el).slice(0, 120),
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    });
  }

  const pageText = (document.body?.innerText ?? "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, textCap);

  return { nodes, pageText };
}

// Resolve a nearText strategy: find the unique element whose OWN text contains
// the value, then pick the associated control (or containing row for extract).
// Marks the pick with data-spick=<nonce>; ambiguity is reported, never guessed.
function nearTextPick(args: { value: string; forExtract: boolean; nonce: string }): PickResult {
  const { value, forExtract, nonce } = args;
  document.querySelectorAll("[data-spick]").forEach((el) => el.removeAttribute("data-spick"));

  const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const needle = norm(value);
  if (!needle) return { status: "none" };
  const vis = (el: Element): boolean =>
    el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const ownText = (el: Element): string => {
    let t = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) t += n.textContent ?? "";
    });
    return norm(t);
  };
  const isInteractive = (el: Element): boolean => {
    const t = el.tagName;
    return (
      t === "BUTTON" ||
      t === "SELECT" ||
      t === "TEXTAREA" ||
      (t === "INPUT" && (el.getAttribute("type") ?? "").toLowerCase() !== "hidden") ||
      (t === "A" && el.hasAttribute("href")) ||
      el.hasAttribute("onclick")
    );
  };
  const mark = (el: Element): PickResult => {
    el.setAttribute("data-spick", nonce);
    return { status: "ok" };
  };

  const all = Array.from(document.querySelectorAll("body *")).filter(
    (el) => el.tagName !== "SCRIPT" && el.tagName !== "STYLE" && vis(el)
  );
  const anchors = all.filter((el) => ownText(el).includes(needle));
  if (anchors.length === 0) return { status: "none" };
  if (anchors.length > 1) return { status: "ambiguous", count: anchors.length };
  const anchor = anchors[0]!;

  if (forExtract) return mark(anchor.closest("tr") ?? anchor);
  if (isInteractive(anchor)) return mark(anchor);
  if (anchor.tagName === "LABEL") {
    const forId = (anchor as HTMLLabelElement).htmlFor;
    if (forId) {
      const ctl = document.getElementById(forId);
      if (ctl && vis(ctl)) return mark(ctl);
    }
  }

  const candidates = all.filter((el) => el !== anchor && isInteractive(el));
  const tr = anchor.closest("tr");
  let pool = candidates;
  if (tr) {
    const inRow = candidates.filter((el) => tr.contains(el));
    if (inRow.length > 0) pool = inRow;
  }
  if (pool.length === 0) return { status: "none" };
  if (pool.length === 1) return mark(pool[0]!);

  const center = (el: Element): { x: number; y: number } => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const a = center(anchor);
  const scored = pool
    .map((el) => {
      const c = center(el);
      return { el, d: Math.hypot(c.x - a.x, c.y - a.y) };
    })
    .sort((p, q) => p.d - q.d);
  if (Math.abs(scored[0]!.d - scored[1]!.d) < 2) return { status: "ambiguous", count: 2 };
  return mark(scored[0]!.el);
}

// Resolve a css strategy against VISIBLE elements only (a dismissed dialog that
// is still in the DOM must not match, and must not create false ambiguity).
function cssPick(args: { value: string; nonce: string }): PickResult {
  const { value, nonce } = args;
  document.querySelectorAll("[data-spick]").forEach((el) => el.removeAttribute("data-spick"));
  let els: Element[];
  try {
    els = Array.from(document.querySelectorAll(value));
  } catch {
    return { status: "none" };
  }
  const vis = (el: Element): boolean =>
    el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  els = els.filter(vis);
  if (els.length === 0) return { status: "none" };
  if (els.length > 1) return { status: "ambiguous", count: els.length };
  els[0]!.setAttribute("data-spick", nonce);
  return { status: "ok" };
}

function bboxPick(args: { box: [number, number, number, number]; nonce: string }): PickResult {
  const { box, nonce } = args;
  document.querySelectorAll("[data-spick]").forEach((el) => el.removeAttribute("data-spick"));
  const el = document.elementFromPoint(box[0] + box[2] / 2, box[1] + box[3] / 2);
  if (!el) return { status: "none" };
  const target = el.closest("a[href], button, input, select, textarea, [onclick]") ?? el;
  target.setAttribute("data-spick", nonce);
  return { status: "ok" };
}

function synthesize(el: Element): {
  role: string;
  name: string;
  labelText: string | null;
  nearText: string | null;
  css: string;
  bbox: [number, number, number, number];
} {
  const clean = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();

  const roleOf = (e: Element): string => {
    const explicit = e.getAttribute("role");
    if (explicit) return explicit;
    const tag = e.tagName.toLowerCase();
    if (tag === "a") return e.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (e.getAttribute("type") ?? "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox";
    }
    return tag;
  };

  let labelText: string | null = null;
  if (el.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lab) labelText = clean(lab.textContent) || null;
  }
  if (!labelText) {
    const wrap = el.closest("label");
    if (wrap) labelText = clean(wrap.textContent) || null;
  }

  const accName = (e: Element): string => {
    const aria = e.getAttribute("aria-label");
    if (aria) return clean(aria);
    if (labelText) return labelText;
    const tag = e.tagName.toLowerCase();
    if (tag === "input") {
      const t = (e.getAttribute("type") ?? "text").toLowerCase();
      const v = (e as HTMLInputElement).value;
      if ((t === "button" || t === "submit" || t === "reset") && v) return clean(v);
    }
    if (tag === "a" || tag === "button" || e.getAttribute("role")) {
      const t = clean(e.textContent);
      if (t) return t.slice(0, 80);
    }
    return clean(e.getAttribute("placeholder")) || clean(e.getAttribute("title")) || "";
  };

  // Legacy-table label: prefer the row's first cell (the semantic row key in
  // legacy grids), fall back to the immediately preceding cell.
  let nearText: string | null = null;
  const cell = el.closest("td, th");
  const rowFirst = el.closest("tr")?.querySelector("td, th");
  const anchorCell = rowFirst && rowFirst !== cell && clean(rowFirst.textContent) ? rowFirst : cell?.previousElementSibling;
  if (anchorCell) {
    const t = clean(anchorCell.textContent).replace(/:\s*$/, "").slice(0, 40);
    if (t) nearText = t;
  }

  let css: string;
  if (el.id) {
    css = `#${CSS.escape(el.id)}`;
  } else {
    const segs: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.tagName !== "BODY" && segs.length < 5) {
      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        segs.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
      } else {
        segs.unshift(tag);
      }
      if (parent?.id) {
        segs.unshift(`#${CSS.escape(parent.id)}`);
        break;
      }
      cur = parent;
    }
    css = segs.join(" > ");
  }

  const r = el.getBoundingClientRect();
  return {
    role: roleOf(el),
    name: accName(el).slice(0, 120),
    labelText,
    nearText,
    css,
    bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const PAGE_TEXT_CAP = 6000;

// Runs inside every document. Listeners are installed unconditionally but the
// exposed binding only forwards to Node while a capture handler is set, so
// this is inert outside human-control windows.
function installHumanCaptureFn(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__scribeCapInstalled) return;
  w.__scribeCapInstalled = true;
  const send = (ev: Record<string, unknown>): void => {
    const fn = w.__scribeHumanEvent as ((e: unknown) => void) | undefined;
    if (typeof fn === "function") fn(ev);
  };
  const describe = (el: Element | null): Record<string, unknown> => ({
    tag: el ? el.tagName.toLowerCase() : undefined,
    id: el && (el as HTMLElement).id ? (el as HTMLElement).id : undefined,
    name: el?.getAttribute("name") ?? undefined,
  });
  document.addEventListener(
    "click",
    (e) => {
      const raw = e.target as Element | null;
      const t = raw?.closest("a,button,input,select,[role=button],[onclick]") ?? raw;
      send({ kind: "click", url: location.href, ...describe(t) });
    },
    true,
  );
  document.addEventListener(
    "change",
    (e) => {
      const t = e.target as HTMLInputElement | null;
      if (!t) return;
      // Same sensitivity contract as screenshot masking: password inputs and
      // anything the app marks data-scribe-sensitive are masked at the source,
      // before the value ever crosses into the Node side of the capture.
      const sensitive =
        t.type === "password" || t.closest('[data-scribe-sensitive="1"]') !== null;
      const value = sensitive ? "***" : t.value;
      send({ kind: "input", url: location.href, ...describe(t), value });
    },
    true,
  );
  document.addEventListener(
    "submit",
    (e) => {
      send({ kind: "submit", url: location.href, ...describe(e.target as Element | null) });
    },
    true,
  );
}

export class PlaywrightDriver implements SurfaceDriver {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private nonceSeq = 0;
  private captureHandler?: (e: HumanActionEvent) => void;
  private navListener?: (f: Frame) => void;

  constructor(
    private readonly policy: PolicyEngine,
    private readonly logger?: RunLogger,
    private readonly opts: DriverOptions = {},
  ) {}

  private get p(): Page {
    if (!this.page) throw new Error("driver not launched");
    return this.page;
  }

  async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: !this.opts.headed });
    this.context = await this.browser.newContext({ viewport: { width: 1280, height: 900 } });
    // tsx/esbuild transpiles with keepNames, injecting __name(...) calls into
    // function source; Playwright serializes evaluate() callbacks from that
    // transpiled source, so the helper must also exist inside every document.
    await this.context.addInitScript("globalThis.__name = (t) => t;");
    await this.context.exposeBinding("__scribeHumanEvent", (_src, ev: HumanActionEvent) => {
      this.captureHandler?.(ev);
    });
    await this.context.addInitScript(installHumanCaptureFn);
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.opts.actTimeoutMs ?? 10_000);
    this.page.setDefaultNavigationTimeout(15_000);
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
  }

  async startHumanCapture(onEvent: (e: HumanActionEvent) => void): Promise<void> {
    this.captureHandler = onEvent;
    this.navListener = (f: Frame) => {
      if (f === this.page?.mainFrame()) onEvent({ kind: "navigate", url: f.url() });
    };
    this.p.on("framenavigated", this.navListener);
  }

  async stopHumanCapture(): Promise<void> {
    if (this.navListener) this.page?.off("framenavigated", this.navListener);
    this.navListener = undefined;
    this.captureHandler = undefined;
  }

  url(): string {
    return this.page?.url() ?? "about:blank";
  }

  async title(): Promise<string> {
    return this.p.title();
  }

  private framePathOf(frame: Frame): string[] {
    const segs: string[] = [];
    let f: Frame | null = frame;
    while (f && f.parentFrame()) {
      let seg = f.name();
      if (!seg) {
        try {
          seg = new URL(f.url()).pathname;
        } catch {
          seg = "?";
        }
      }
      segs.unshift(seg);
      f = f.parentFrame();
    }
    return segs;
  }

  private frameFor(path: string[]): Frame | undefined {
    if (path.length === 0) return this.p.mainFrame();
    const want = path.join("/");
    return this.p.frames().find((f) => this.framePathOf(f).join("/") === want);
  }

  async observe(): Promise<Observation> {
    const page = this.p;
    const nodes: UiNode[] = [];
    const texts: string[] = [];
    const frames = page.frames();
    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi]!;
      if (frame.isDetached()) continue;
      let snap: { nodes: RawNode[]; pageText: string };
      try {
        snap = await frame.evaluate(snapshotPage, { frameIndex: fi, textCap: PAGE_TEXT_CAP });
      } catch {
        continue; // frame navigated away mid-observation
      }
      const framePath = this.framePathOf(frame);
      for (const n of snap.nodes) nodes.push({ ...n, framePath });
      if (snap.pageText) texts.push(snap.pageText);
    }
    return {
      url: page.url(),
      title: await page.title(),
      nodes,
      pageText: texts.join("\n---\n").slice(0, PAGE_TEXT_CAP),
    };
  }

  // --- resolution -----------------------------------------------------------

  private nextNonce(): string {
    this.nonceSeq += 1;
    return `sp${Date.now().toString(36)}${this.nonceSeq.toString(36)}`;
  }

  private async tryStrategy(
    frame: Frame,
    s: LocatorStrategy,
    forExtract: boolean,
  ): Promise<{ count: number; loc?: Locator }> {
    switch (s.kind) {
      case "role": {
        const role = s.role as Parameters<Frame["getByRole"]>[0];
        const loc =
          s.name !== undefined
            ? frame.getByRole(role, { name: s.name, exact: s.exact ?? false })
            : frame.getByRole(role);
        const count = await loc.count();
        return { count, loc: count === 1 ? loc.first() : undefined };
      }
      case "labelText": {
        const loc = frame.getByLabel(s.value);
        const count = await loc.count();
        return { count, loc: count === 1 ? loc.first() : undefined };
      }
      case "nearText": {
        const nonce = this.nextNonce();
        const res = await frame.evaluate(nearTextPick, { value: s.value, forExtract, nonce });
        if (res.status === "ambiguous") return { count: res.count };
        if (res.status === "none") return { count: 0 };
        return { count: 1, loc: frame.locator(`[data-spick="${nonce}"]`) };
      }
      case "css": {
        const nonce = this.nextNonce();
        const res = await frame.evaluate(cssPick, { value: s.value, nonce });
        if (res.status === "ambiguous") return { count: res.count };
        if (res.status === "none") return { count: 0 };
        return { count: 1, loc: frame.locator(`[data-spick="${nonce}"]`) };
      }
      case "bbox": {
        const nonce = this.nextNonce();
        const res = await frame.evaluate(bboxPick, { box: s.value, nonce });
        if (res.status !== "ok") return { count: 0 };
        return { count: 1, loc: frame.locator(`[data-spick="${nonce}"]`) };
      }
    }
  }

  private async resolveInternal(
    target: StepTarget,
    forExtract: boolean,
  ): Promise<
    | { loc: Locator; rank: number; kind: string }
    | { outcome: Extract<ResolveOutcome, { status: "ambiguous" } | { status: "not_found" }> }
  > {
    const frame = this.frameFor(target.framePath);
    if (!frame) {
      return { outcome: { status: "not_found", tried: [`frame [${target.framePath.join(" > ")}]`] } };
    }
    const tried: string[] = [];
    for (let rank = 0; rank < target.strategies.length; rank++) {
      const s = target.strategies[rank]!;
      tried.push(describeStrategy(s));
      const r = await this.tryStrategy(frame, s, forExtract);
      if (r.count === 1 && r.loc) return { loc: r.loc, rank, kind: s.kind };
      if (r.count > 1) {
        // Fail the whole resolve: falling through past an ambiguous match
        // risks acting on the wrong element. Never guess.
        return { outcome: { status: "ambiguous", rank, kind: s.kind, count: r.count } };
      }
    }
    return { outcome: { status: "not_found", tried } };
  }

  async resolve(target: StepTarget, opts?: { forExtract?: boolean }): Promise<ResolveOutcome> {
    const r = await this.resolveInternal(target, opts?.forExtract ?? false);
    if ("outcome" in r) return r.outcome;
    return { status: "ok", rank: r.rank, kind: r.kind };
  }

  private async locatorForRef(ref: string): Promise<Locator | undefined> {
    for (const frame of this.p.frames()) {
      if (frame.isDetached()) continue;
      const loc = frame.locator(`[data-sref="${ref}"]`);
      if ((await loc.count()) === 1) return loc.first();
    }
    return undefined;
  }

  // --- the chokepoint -------------------------------------------------------

  async act(req: ActionRequest & { ref?: string }): Promise<ActResult> {
    const actor: Actor = req.phase === "discovery" ? "agent" : req.phase === "human" ? "human" : "replay";
    const logBase: Record<string, unknown> = {
      kind: req.kind,
      phase: req.phase,
      risk: req.risk,
      stepId: req.stepId,
      intent: req.intent,
      url: req.kind === "navigate" ? req.url : undefined,
      value: req.sensitive ? "***" : req.value,
      key: req.key,
      target: req.target?.elementDescription ?? (req.ref ? `ref=${req.ref}` : undefined),
    };

    // Policy is consulted here, inside the driver, so no caller can bypass it.
    const decision = this.policy.checkAction(req, this.url());
    if (decision.decision === "deny") {
      this.logger?.log(actor, "policy_deny", { ...logBase, reason: decision.reason });
      return { ok: false, denied: decision.reason };
    }
    if (decision.decision === "require_approval" && !req.approved) {
      this.logger?.log(actor, "policy_needs_approval", { ...logBase, reason: decision.reason });
      return { ok: false, needsApproval: decision.reason };
    }

    try {
      if (req.kind === "navigate") {
        if (!req.url) return { ok: false, error: "navigate requires url" };
        await this.p.goto(req.url, { waitUntil: "domcontentloaded" });
        this.logger?.log(actor, "act_navigate", logBase);
        return { ok: true };
      }

      let loc: Locator | undefined;
      let strategyRank: number | undefined;
      let strategyKind: string | undefined;

      if (req.ref) {
        loc = await this.locatorForRef(req.ref);
        if (!loc) {
          this.logger?.log(actor, "act_failed", { ...logBase, error: `stale ref ${req.ref}` });
          return { ok: false, notFound: true, error: `ref ${req.ref} not found (stale observation?)` };
        }
      } else if (req.target) {
        const r = await this.resolveInternal(req.target, req.kind === "extract");
        if ("outcome" in r) {
          const o = r.outcome;
          if (o.status === "ambiguous") {
            const error = `target "${req.target.elementDescription}" matched ${o.count} elements via ${o.kind} (rank ${o.rank}) — failing closed`;
            this.logger?.log(actor, "act_failed", { ...logBase, error });
            return { ok: false, ambiguous: true, strategyRank: o.rank, strategyKind: o.kind, error };
          }
          const error = `target "${req.target.elementDescription}" not found; tried: ${o.tried.join("; ")}`;
          this.logger?.log(actor, "act_failed", { ...logBase, error });
          return { ok: false, notFound: true, error };
        }
        loc = r.loc;
        strategyRank = r.rank;
        strategyKind = r.kind;
      } else if (req.kind !== "press") {
        return { ok: false, error: `${req.kind} requires a target` };
      }

      const timeout = this.opts.actTimeoutMs ?? 10_000;
      let extracted: string | undefined;

      switch (req.kind) {
        case "click": {
          await loc!.click({ timeout });
          await this.p.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
          break;
        }
        case "fill": {
          if (req.value === undefined) return { ok: false, error: "fill requires value" };
          await loc!.fill(req.value, { timeout });
          if (req.sensitive) {
            this.logger?.redactor.register(req.value);
            await loc!.evaluate((el) => el.setAttribute("data-scribe-sensitive", "1"));
          }
          break;
        }
        case "select": {
          if (req.value === undefined) return { ok: false, error: "select requires value" };
          try {
            await loc!.selectOption({ label: req.value }, { timeout });
          } catch {
            await loc!.selectOption(req.value, { timeout });
          }
          break;
        }
        case "press": {
          if (!req.key) return { ok: false, error: "press requires key" };
          if (loc) await loc.press(req.key, { timeout });
          else await this.p.keyboard.press(req.key);
          await this.p.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
          break;
        }
        case "extract": {
          const tag = await loc!.evaluate((el) => el.tagName.toLowerCase());
          const raw =
            tag === "input" || tag === "select" || tag === "textarea"
              ? await loc!.inputValue({ timeout })
              : await loc!.innerText({ timeout });
          const text = raw.replace(/\s+/g, " ").trim();
          if (req.extractPattern) {
            const m = text.match(new RegExp(req.extractPattern));
            if (!m) {
              const error = `extract pattern /${req.extractPattern}/ did not match "${text.slice(0, 120)}"`;
              this.logger?.log(actor, "act_failed", { ...logBase, strategyRank, strategyKind, error });
              return { ok: false, strategyRank, strategyKind, error };
            }
            extracted = m[1] ?? m[0];
          } else {
            extracted = text;
          }
          // Register sensitive extracts immediately so every later log line,
          // screenshot label, and the persisted result mask this value.
          if (req.sensitive && extracted) this.logger?.redactor.register(extracted);
          break;
        }
      }

      this.logger?.log(actor, `act_${req.kind}`, {
        ...logBase,
        strategyRank,
        strategyKind,
        extracted: req.sensitive ? "***" : extracted,
      });
      return { ok: true, extracted, strategyRank, strategyKind };
    } catch (e) {
      const error = e instanceof Error ? e.message.split("\n")[0] : String(e);
      this.logger?.log(actor, "act_failed", { ...logBase, error });
      return { ok: false, error };
    }
  }

  // --- recording support ----------------------------------------------------

  async synthesizeTarget(ref: string): Promise<TargetSynthesis | null> {
    for (const frame of this.p.frames()) {
      if (frame.isDetached()) continue;
      const loc = frame.locator(`[data-sref="${ref}"]`);
      if ((await loc.count()) !== 1) continue;
      const s = await loc.first().evaluate(synthesize);
      const strategies: LocatorStrategy[] = [];
      if (s.name) strategies.push({ kind: "role", role: s.role, name: s.name });
      if (s.labelText) strategies.push({ kind: "labelText", value: s.labelText });
      if (s.nearText) strategies.push({ kind: "nearText", value: s.nearText });
      strategies.push({ kind: "css", value: s.css });
      strategies.push({ kind: "bbox", value: s.bbox });
      const desc = s.name
        ? `${s.role} "${s.name}"`
        : s.nearText
          ? `${s.role} near "${s.nearText}"`
          : `${s.role} at ${s.css}`;
      return {
        target: { strategies, elementDescription: desc, framePath: this.framePathOf(frame) },
        role: s.role,
        name: s.name,
      };
    }
    return null;
  }

  // --- conditions -----------------------------------------------------------

  private async strategyMatches(s: LocatorStrategy): Promise<{ count: number; loc?: Locator }> {
    for (const frame of this.p.frames()) {
      if (frame.isDetached()) continue;
      try {
        const r = await this.tryStrategy(frame, s, false);
        if (r.count > 0) return r;
      } catch {
        continue;
      }
    }
    return { count: 0 };
  }

  async evalCondition(cond: Condition): Promise<boolean> {
    if ("all" in cond) {
      for (const c of cond.all) if (!(await this.evalCondition(c))) return false;
      return true;
    }
    if ("any" in cond) {
      for (const c of cond.any) if (await this.evalCondition(c)) return true;
      return false;
    }
    if ("not" in cond) return !(await this.evalCondition(cond.not));
    if ("urlMatches" in cond) return new RegExp(cond.urlMatches).test(this.url());
    if ("textPresent" in cond) {
      for (const frame of this.p.frames()) {
        if (frame.isDetached()) continue;
        try {
          const text = await frame.evaluate(() => document.body?.innerText ?? "");
          if (text.replace(/\s+/g, " ").includes(cond.textPresent)) return true;
        } catch {
          continue;
        }
      }
      return false;
    }
    if ("elementVisible" in cond) return (await this.strategyMatches(cond.elementVisible)).count > 0;
    if ("elementAbsent" in cond) return (await this.strategyMatches(cond.elementAbsent)).count === 0;
    const { target, pattern } = cond.valueMatches;
    const r = await this.strategyMatches(target);
    if (r.count !== 1 || !r.loc) return false;
    const tag = await r.loc.evaluate((el) => el.tagName.toLowerCase());
    const text =
      tag === "input" || tag === "select" || tag === "textarea"
        ? await r.loc.inputValue()
        : await r.loc.innerText();
    return new RegExp(pattern).test(text.replace(/\s+/g, " ").trim());
  }

  async waitForCondition(cond: Condition, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await this.evalCondition(cond)) return true;
      } catch {
        // mid-navigation flake: treat as "not yet"
      }
      if (Date.now() >= deadline) return false;
      await sleep(250);
    }
  }

  async screenshot(absPath: string): Promise<void> {
    await this.p.screenshot({
      path: absPath,
      mask: [this.p.locator('input[type="password"]'), this.p.locator('[data-scribe-sensitive="1"]')],
      maskColor: "#1e1e1e",
    });
  }
}
