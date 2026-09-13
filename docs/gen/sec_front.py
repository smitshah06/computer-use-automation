"""Cover, TOC, and sections 1-4."""
from reportlab.platypus import NextPageTemplate, PageBreak, Spacer, Table, TableStyle

from doc import make_toc
from style import (
    CONTENT_W, GRAYTXT, LIGHT, NAVY, TEAL, S_BODY, S_QUOTE, S_SUB, S_TITLE,
    H1, H2, H3, P, bull, callout, code, cpb, serves, sp, tbl,
)
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph

S_META_K = ParagraphStyle("MetaK", fontName="Helvetica-Bold", fontSize=9,
                          leading=12.5, textColor=NAVY)
S_META_V = ParagraphStyle("MetaV", fontName="Helvetica", fontSize=9,
                          leading=12.5)


def cover():
    story = []
    story.append(Spacer(1, 90))
    story.append(Paragraph("Computer-Use Automation System", S_TITLE))
    story.append(Spacer(1, 6))
    t = Table([[""]], colWidths=[120], rowHeights=[3])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), TEAL)]))
    story.append(t)
    story.append(Spacer(1, 14))
    story.append(Paragraph(
        "Implementation and Design Plan - interface.ai Engineering Take-Home",
        S_SUB))
    story.append(Spacer(1, 40))

    meta = [
        ["Assignment", "Take-Home Project: Computer-Use Automation System (interface.ai)"],
        ["Deliverable", "Design document justified against the published evaluation criteria, revised to describe the system as built"],
        ["Stack", "TypeScript + Node.js 22, Playwright, LLM provider adapter (Anthropic + OpenAI), Zod"],
        ["Target surface", "Locally built mock credit-union back-office app (deliberately legacy-hostile), plus a re-skinned second-tenant variant"],
        ["Date", "September 2026 (as-built revision: September 13)"],
        ["Status", "As-built v1.1 - implementation complete; 93/93 tests green across 14 files"],
    ]
    rows = [[Paragraph(k, S_META_K), Paragraph(v, S_META_V)] for k, v in meta]
    mt = Table(rows, colWidths=[110, CONTENT_W - 110])
    mt.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, LIGHT),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    story.append(mt)
    story.append(Spacer(1, 46))
    story.append(callout("The through-line this design is built around", [
        '"The model discovers. The artifact becomes a reusable capability. '
        'Deterministic replay is how the AI agent invokes it in production."',
        "Every component below exists to serve one of those three phases - or to keep "
        "them safe (policy), observable (evidence), or recoverable (escalation).",
    ]))
    story.append(Spacer(1, 18))
    story.append(P(
        "<b>How to read this document.</b> Each major decision is presented as: "
        "the decision, why it wins, the alternatives it beat and why they lose, and the "
        "evaluation criterion it serves. Section 2 maps the whole design onto the "
        "grading rubric; Sections 5-8 are the load-bearing pieces (artifact schema, "
        "deterministic replay, escalation, safety); Section 14 records the build plan "
        "as executed. This revision replaces the pre-implementation baseline: schemas, "
        "commands, and examples below are taken from the shipped repository, and "
        "places where implementation experience overturned the original design are "
        "called out explicitly (notably the redirect backstop, Section 8.5)."))
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())
    return story


def toc_page():
    return [
        H1("Contents"),
        sp(4),
        make_toc(),
        PageBreak(),
    ]


# --------------------------------------------------------------------------- 1
def sec1():
    story = [H1("1. Executive summary")]
    story.append(P(
        "This document describes <b>Scribe</b>, a small but complete computer-use "
        "automation system built for the interface.ai take-home. Everything described "
        "here is implemented: the claims below are backed by the committed test suite "
        "(93 tests across 14 files, all green) and by committed evidence runs. "
        "Scribe does four things end to end: "
        "(1) an LLM-driven agent accomplishes a natural-language goal against a live UI; "
        "(2) a <b>Recorder</b> distills that successful run into a typed, versioned, "
        "human-reviewable <b>capability artifact</b>; (3) a <b>replay engine</b> executes "
        "that artifact deterministically - no LLM in the decision loop - with an explicit "
        "error taxonomy separating business outcomes, recoverable conditions, and hard "
        "failures; and (4) when it cannot proceed safely, it <b>escalates to a human</b> "
        "who takes control of the same live browser session and hands control back."))
    story.append(P(
        "The system is a <b>modular monolith in TypeScript</b>: one package, ten modules "
        "with enforced dependency boundaries, driven by a CLI plus a minimal local "
        "operator console. It automates a locally built, deliberately legacy-style "
        "<b>mock credit-union back-office</b> so that the exact runtime failures the brief "
        "cares about (record not found, validation errors, permission denials, session "
        "expiry, interstitial dialogs, slow loads) can be reproduced on demand and "
        "demonstrated in committed evidence. A re-skinned second-tenant variant of the "
        "same app (\"CU North TellerWorks\": different branding, labels, and origin) "
        "exists to prove artifact reuse across tenants without re-recording."))
    story.append(sp(2))
    story.append(H2("1.1 Positioning against the brief"))
    story.append(P(
        "The brief is explicit about where the difficulty lives: the artifact schema and "
        "replay contract are \"a focal point of the evaluation\", conflating business "
        "outcomes with failures is \"the most common design mistake\", and escalation must "
        "be \"real, not just a TODO\". This design therefore spends its complexity budget "
        "on three load-bearing pieces - the artifact schema (Section 5), the replay "
        "engine and its deviation classifier (Section 6), and the control-transfer model "
        "(Section 7) - and deliberately keeps everything else thin: no services, no "
        "queues, no database, filesystem JSON stores, a single-page operator console."))
    story.append(H2("1.2 Decisions at a glance"))
    story.append(tbl(
        ["Axis", "Decision", "One-line rationale"],
        [
            ["Language / runtime", "TypeScript on Node.js 22",
             "The rubric's focal point is a typed schema; Zod gives one source of truth "
             "for static types and runtime validation."],
            ["Automation substrate", "Playwright (Chromium, headed)",
             "Actionability auto-waits, first-class iframes, accessibility-tree "
             "snapshots, CDP access for live handoff, built-in tracing."],
            ["Perception", "Accessibility-tree-first hybrid (+ screenshots, bbox fallback)",
             "Works when the DOM is hostile; same abstraction exists on desktop; the "
             "brief says to bias toward no-clean-DOM approaches."],
            ["LLM", "Provider adapter: Anthropic (default) + OpenAI",
             "Tool-calling loop with strict JSON action schemas; provider is a seam, "
             "not a dependency."],
            ["Target app", "Local mock CU back-office with fault injection",
             "Full control over the error states the rubric grades; offline for "
             "reviewers; banking-realistic flows."],
            ["Architecture", "Modular monolith + CLI + local operator console",
             "The brief explicitly does not reward scaling infrastructure; boundaries "
             "live in module contracts."],
            ["Artifact store", "Versioned JSON files in git",
             "Reviewable in PRs (the review workflow IS the approval workflow); "
             "zero setup for reviewers."],
        ],
        [80, 150, CONTENT_W - 230], bold_first_col=True))
    story.append(sp(4))
    story.append(H2("1.3 What is demonstrated (committed evidence and tests)"))
    story.extend(bull([
        "<b>Discovery:</b> real LLM-driven runs (committed provenance: OpenAI gpt-4o) "
        "completing \"Look up member 12345 and read their current savings balance\" and "
        "two further goals against the live mock app - three committed capabilities: "
        "member-savings-lookup, member-standing-check, subaccount-open.",
        "<b>Replay (happy path):</b> each saved artifact re-run with params, no LLM in "
        "the process, checkpoint-verified, returning typed (and redacted) outputs.",
        "<b>Replay (business outcomes):</b> memberId=99999 returns MEMBER_NOT_FOUND and "
        "memberId=66666 returns ACCESS_DENIED as legitimate, structured results - not "
        "errors - alongside success variants (Active and Dormant standing).",
        "<b>Replay (recovery):</b> an injected interstitial dialog is detected and "
        "dismissed by a declared recovery; a slow load is retried within bounds - both "
        "visible in committed telemetry.",
        "<b>Escalation:</b> an injected session expiry exhausts recovery, raises an "
        "intervention, a human takes over the live browser, logs in manually, hands "
        "back with a cryptographically signed disposition, and the run resumes and "
        "completes - all captured in evidence.",
        "<b>Risky-action approval:</b> the mutating sub-account-open submit pauses for "
        "operator approval; a single-use approve_once lets exactly one act attempt "
        "proceed, and the run finishes with a confirmation number.",
        "<b>Cross-tenant reuse:</b> the identical artifact replays against the "
        "re-skinned CU North tenant (different origin, branding, and vocabulary) via a "
        "thin binding overlay - no re-recording, committed as evidence.",
        "<b>Safety:</b> allowlist enforcement at the act() chokepoint plus a "
        "network-layer backstop that aborts page-initiated off-allowlist traffic "
        "(including multi-hop redirect chains); redaction of sensitive values in "
        "artifacts, logs, and screenshots.",
    ]))
    story.append(PageBreak())
    return story


# --------------------------------------------------------------------------- 2
def sec2():
    story = [H1("2. Requirements digest and evaluation mapping")]
    story.append(P(
        "The graders state their weighting order explicitly. The table below maps each "
        "criterion to the design element that answers it and the section that argues it. "
        "This is the contract this document is written against."))
    story.append(tbl(
        ["#", "Evaluation criterion (in stated weight order)", "Design answer", "Where"],
        [
            ["1", "System design - boundaries, data models, trade-offs, simplicity; "
                  "artifact schema and replay contract are central",
             "Modular monolith with three seams (surface, provider, policy); artifact "
             "split into contract / mechanics / policy; typed result contract",
             "Sec. 3, 5"],
            ["2", "Correctness of the core loop - agent completes a real goal; artifact "
                  "replays deterministically and verifies success",
             "Tool-calling discovery loop; Recorder distillation; checkpoint-verified "
             "replay with no LLM import path",
             "Sec. 4, 6"],
            ["3", "Robustness and error handling - runtime errors vs business outcomes "
                  "vs hard failures; locator, wait, checkpoint strategy",
             "Declared outcomes + declared recoveries + fail-closed hard failures, "
             "classified in strict precedence; ranked locators; bounded condition waits",
             "Sec. 6"],
            ["4", "Human-in-the-loop escalation - detect stuck, route with context, "
                  "transfer the live session, resume",
             "Control-ownership state machine (AGENT/PAUSED/HUMAN); intervention store; "
             "same headed browser operated by the human; recorded human actions; "
             "disposition-based resume",
             "Sec. 7"],
            ["5", "Generalization - heterogeneous surfaces; artifact reuse across "
                  "tenants without rebuilds",
             "SurfaceDriver seam + surface-agnostic TargetDescriptor and condition AST; "
             "base artifact + per-tenant binding overlay; drift telemetry",
             "Sec. 10"],
            ["6", "Safety and data handling - allowlist, risky actions, redaction",
             "PolicyEngine chokepoint inside the driver; risk classes with approval "
             "gates; parameterization strips PII from artifacts; masked logs and "
             "screenshots",
             "Sec. 8"],
            ["7", "Code quality - readable, typed, tested where it counts",
             "Strict TS + Zod; dependency-boundary lint; tests focused on schema, "
             "policy, classifier, locators",
             "Sec. 12"],
            ["8", "Communication - reasoning, trade-offs, cut lines",
             "REPORT.md with the seven required headings; explicit cut lines",
             "Sec. 13, 14"],
        ],
        [16, 158, CONTENT_W - 16 - 158 - 44, 44]))
    story.append(sp(6))
    story.append(H2("2.1 Core requirements coverage (brief Section 3)"))
    story.append(tbl(
        ["Requirement", "Coverage in this design"],
        [
            ["3.1 Goal-driven agent loop", "Discovery runner: observe (a11y snapshot) - "
             "decide (LLM tool call) - act (driver), with stop conditions: goal met, "
             "max steps, timeout, loop detection, model-declared stuck."],
            ["3.2 Structured artifact", "CapabilityArtifact v1: typed inputs/outputs, "
             "ranked target strategies, per-step checkpoints, declared outcomes and "
             "recoveries, policy block, provenance. Section 5."],
            ["3.3 Deterministic replay", "Replay engine with per-step algorithm, "
             "deviation classifier, four-state result contract, bounded waits, "
             "fail-closed ambiguity handling. Section 6."],
            ["3.4 Safety guardrails", "Deny-by-default allowlist, risk classes with "
             "conservative gates, no secrets or raw PII persisted. Section 8."],
            ["3.5 Evidence / observability", "Per-run JSONL event log with actor "
             "attribution + screenshots at steps, checkpoints, and failures. Section 9."],
            ["3.6 Escalation and handoff", "Intervention requests with context; live "
             "session control transfer; human-action recording; resume semantics. "
             "Section 7."],
            ["3.7 Heterogeneity and scale", "Surface abstraction (design) and "
             "multi-tenant overlay model with a working cross-tenant replay against a "
             "second tenant app (built); drift telemetry + locator-health report "
             "(built). Section 10."],
        ],
        [120, CONTENT_W - 120], bold_first_col=True))
    story.append(PageBreak())
    return story


# --------------------------------------------------------------------------- 3
ARCH_DIAGRAM = r"""
    +----------------------------------------------------------------------+
    |                                 CLI                                  |
    |            discover | replay | approve | catalog | health            |
    +--------+------------------------+------------------------+-----------+
             |                        |                        |
    +--------v---------+     +--------v---------+     +--------v---------+
    | DiscoveryRunner  |     |   ReplayEngine   |     | Operator Console |
    |  (LLM decides)   |     |     (NO LLM)     |     |  localhost:4700  |
    +--------+---------+     +--------+---------+     +--------+---------+
             |                        |                        |
    +--------v---------+     +--------v---------+     +--------v---------+
    |   LLMProvider    |     |  RunController   |     |InterventionStore |
    |Anthropic / OpenAI|     |control ownership:|     |  (JSON records,  |
    +------------------+     |AGENT/PAUSED/HUMAN|     | evidence links)  |
                             +--------+---------+     +------------------+
                                      |
                     +----------------v----------------+
                     |          SurfaceDriver          |
                     |     observe / resolve / act     |
                     |    [PolicyEngine chokepoint]    |
                     +----------------+----------------+
                                      |
                     +----------------v----------------+  future drivers:
                     |      PlaywrightDriver (web)     | --> desktop (UIA/AX),
                     +----------------+----------------+  vision (screenshot)
                                      |
                     +----------------v----------------+
                     |     Mock CU back-office app     |
                     |     (fault-injection hooks)     |
                     +---------------------------------+

   cross-cutting:  core/ (Zod schemas + types) is imported by every module;
                   evidence/ (redacting logger, screenshots, run directories)
"""


def sec3():
    story = [H1("3. System architecture")]
    story.append(serves("System design (criterion 1) - clear boundaries, appropriate simplicity."))
    story.append(P(
        "Scribe is a single TypeScript package organized as a <b>modular monolith</b>: "
        "ten modules with explicit, lint-enforced dependency rules, wired together by a "
        "CLI. There are no services, queues, or databases - by design, and the brief "
        "says plainly that building scaling infrastructure is not rewarded. The "
        "boundaries that matter for the real environment exist as <b>interfaces</b> "
        "(seams), each aligned to an axis of change: the surface you automate, the "
        "model provider you call, and the policy you enforce."))
    story.extend(code(ARCH_DIAGRAM, small=True, chunk=60))
    story.append(sp(6))
    story.append(H2("3.1 Modules and dependency rules"))
    story.append(tbl(
        ["Module", "Responsibility", "May depend on"],
        [
            ["core/", "Zod schemas + inferred types: artifact, result contract, "
             "condition AST, policy config, intervention records. Pure data.", "nothing"],
            ["surface/", "SurfaceDriver interface + PlaywrightDriver. Observation "
             "(a11y snapshots), target resolution, actions. Hosts the policy chokepoint.",
             "core, policy, evidence"],
            ["llm/", "LLMProvider interface + Anthropic and OpenAI implementations; "
             "strict JSON tool schemas for agent actions.", "core"],
            ["agent/", "Discovery loop (observe-decide-act), stop conditions, Recorder "
             "(distills run into an artifact, parameterizes literals).",
             "core, surface, llm, policy, evidence, escalation"],
            ["replay/", "Deterministic executor: waits, resolution, checkpoints, "
             "DeviationClassifier, recoveries, result contract. <b>No import path to "
             "llm/ - determinism by construction, enforced by lint.</b>",
             "core, surface, policy, evidence, escalation"],
            ["policy/", "PolicyEngine: allowlist, action-kind rules, risk "
             "classification, approval gates.", "core"],
            ["escalation/", "RunController (control-ownership state machine), "
             "intervention store, operator console server, human-action recorder.",
             "core, evidence"],
            ["evidence/", "Redacting structured logger (JSONL), screenshot capture, "
             "run directory management.", "core"],
            ["target-app/", "Mock CU back-office (Express + EJS) with fault-injection "
             "hooks. Runs standalone; no imports from the system.", "nothing"],
            ["cli/", "Command wiring: discover, replay, approve, catalog, health.", "all"],
        ],
        [62, CONTENT_W - 62 - 118, 118], bold_first_col=True))
    story.append(sp(4))
    story.append(H2("3.2 The three data flows"))
    story.extend(bull([
        "<b>Discovery:</b> goal + example params in - the runner loops "
        "(snapshot - LLM decision - policy check - act - record) until the model marks "
        "success or a stop condition fires; the Recorder then distills the action trace "
        "into a CapabilityArtifact, replacing literal values with parameter references, "
        "and writes it to capabilities/ as reviewable JSON.",
        "<b>Replay:</b> artifact + params in - preflight (validate params with Zod, "
        "load policy, verify app fingerprint) - per-step execute-and-verify - on "
        "deviation, classify (outcome / recovery / hard failure) - typed result out. "
        "No model calls anywhere on this path; it runs with no API key configured.",
        "<b>Escalation:</b> any phase can raise an intervention - the RunController "
        "flips control to PAUSED and parks the automation on a control mutex - the "
        "operator claims it in the console, drives the same headed browser, and "
        "resumes with a disposition - the engine re-verifies state and continues, "
        "with every human action recorded in the same evidence stream.",
    ]))
    story.append(sp(2))
    story.append(H2("3.3 Why a modular monolith (and not services)"))
    story.append(callout("Decision: one process per run, seams as interfaces, filesystem stores", [
        "<b>Why.</b> A discovery or replay run is a single, short-lived, stateful "
        "session bound to one live browser - there is no concurrency problem for a "
        "take-home to solve, and the rubric explicitly withholds credit for queues, "
        "clusters, and multi-tenant plumbing. Every boundary that would matter at "
        "scale is expressed as a TypeScript interface with a dependency rule, which "
        "is what actually gets evaluated: can the design grow without rewrites?",
        "<b>Rejected: microservices / job queue.</b> Adds deployment and IPC "
        "complexity that demonstrates nothing the rubric measures; hides the seams "
        "inside network plumbing instead of readable contracts.",
        "<b>Rejected: SQLite/Postgres for artifacts and interventions.</b> A database "
        "adds reviewer setup friction and makes artifacts less reviewable. JSON files "
        "in git mean an artifact diff is a PR diff - which doubles as the "
        "review/approval workflow the artifact lifecycle needs (Section 5.6).",
        "<b>Production path (documented, not built).</b> Each module maps 1:1 to a "
        "service later: driver pool per tenant, artifact registry, intervention "
        "queue + operator UI. The interfaces are the migration plan.",
    ]))
    story.append(PageBreak())
    return story


# --------------------------------------------------------------------------- 4
def sec4():
    story = [H1("4. Technology decisions and rejected alternatives")]
    story.append(serves("System design, correctness of the core loop, code quality."))
    story.append(tbl(
        ["Decision", "Why it wins", "Rejected alternatives and why"],
        [
            ["<b>TypeScript + Node.js 22</b>",
             "The artifact schema is the rubric's focal point: Zod provides one "
             "definition yielding both static types and runtime validation of every "
             "artifact, param set, and result. Discriminated unions model the result "
             "contract natively. One language across agent, replay, console, and "
             "target app.",
             "Python + Pydantic: entirely viable, but Playwright is TS-first, and "
             "splitting languages (Python system, JS console/app) weakens cohesion. "
             "Go/Java: slower iteration, weaker browser-automation ecosystem."],
            ["<b>Playwright</b>",
             "Actionability auto-waits (visible/enabled/stable) remove the sleep-based "
             "flake that kills deterministic replay; first-class frame support (legacy "
             "framesets); accessibility snapshots for perception; CDP access underpins "
             "the live-session handoff; built-in tracing and screenshots feed evidence.",
             "Selenium: manual wait discipline, flakier under dynamic content. "
             "Puppeteer: Chromium-only, thinner a11y and locator APIs. Computer-use / "
             "browser-agent SDKs: they hide exactly the loop, locator, and policy "
             "design this assignment evaluates, and their actions bypass our policy "
             "chokepoint."],
            ["<b>Accessibility-tree-first perception</b>",
             "The brief: bias toward approaches that survive a hostile DOM. The agent "
             "observes a numbered snapshot of role/name/value/state/bbox nodes - not "
             "raw HTML - so decisions attach to semantics a human would use. The same "
             "abstraction exists on desktop (UIA/MSAA, macOS AX), which is the "
             "generalization story. Screenshots supplement when structure is ambiguous.",
             "Raw DOM/CSS-first: brittle on server-rendered legacy markup, dead end "
             "for desktop. Pure screenshot + coordinates: universal but brittle to "
             "layout shifts and poor for review; retained only as the recorded "
             "last-resort strategy (bbox + element description)."],
            ["<b>LLM provider adapter (Anthropic default, OpenAI alternate)</b>",
             "Decisions come back as strict, schema-validated tool calls (click/fill/"
             "extract/...), each carrying machine-usable arguments plus human-readable "
             "intent and reasoning - which is what makes the recorded artifact "
             "reviewable. Temperature 0. The provider is a seam: one interface, two "
             "implementations, swappable by flag.",
             "Hardcoding one vendor: cheaper but forfeits the seam. Free-text "
             "prompting + parsing: fragile, unvalidatable, and worse for recording "
             "structured steps."],
            ["<b>Local mock CU back-office as target</b>",
             "The rubric grades how replay handles runtime states: not-found, "
             "validation errors, permission denials, session expiry, interstitials, "
             "slow loads. A local app makes each reproducible on demand via injection "
             "flags - so the committed evidence can show every class. Banking-shaped "
             "flows (member search, balances, sub-account open) mirror the brief's own "
             "examples. Offline and ToS-clean for reviewers; the tenant-B variant "
             "(CU North TellerWorks) is built and used in the cross-tenant demo.",
             "Public demo sites (saucedemo, demoqa): zero build cost but cannot "
             "produce session expiry or permission denials on demand, which guts the "
             "robustness demonstration; ToS and rate-limit caveats; no domain "
             "realism."],
        ],
        [92, 206, CONTENT_W - 92 - 206]))
    story.append(sp(6))
    story.append(H2("4.1 The discovery loop, concretely"))
    story.append(P(
        "Each turn, the runner sends the model: the goal, declared input parameters "
        "(names + example values), a compact numbered accessibility snapshot "
        "(ref, role, name, value, state per node, plus URL and title), the last action's "
        "result, and optionally a screenshot. The model must respond with exactly one "
        "tool call from a closed set:"))
    story.extend(code(
        "act(kind: navigate|click|fill|select|press, ref|url, value?, key?,\n"
        "    risk: safe|risky, intent, reasoning)\n"
        "extract(ref, outputName, type: string|number|money|date, sensitive?,\n"
        "        extractPattern?, intent, reasoning)\n"
        "declare_outcome(code, description, detectorText, reasoning)\n"
        "finish(status: success|stuck, summary, reasoning)"))
    story.append(P(
        "Stop conditions (as built): finish(success), finish(stuck), turn budget "
        "(policy default 40), wall-clock budget (5 minutes), the same action against "
        "the same page state observed three times (loop detection), provider failure "
        "after retries, or an operator abort at a risky-action approval. "
        "declare_outcome is grounded: the engine rejects it unless the declared "
        "detector text is actually visible on the current screen. Every executed "
        "action plus the observation that followed it is appended to the run trace "
        "that the Recorder distills. The model never executes anything itself: every "
        "action passes through the same SurfaceDriver - and therefore the same "
        "PolicyEngine - that replay uses."))
    story.append(H2("4.2 Where typed inputs, outputs, and outcomes come from"))
    story.extend(bull([
        "<b>Inputs:</b> declared at the CLI at discovery time (e.g. memberId=12345). "
        "The Recorder replaces exact literal occurrences in fills and URLs with "
        "{{inputs.memberId}} - parameterization doubles as PII stripping.",
        "<b>Outputs:</b> the agent's extract(name, ref, type) calls declare them; the "
        "Recorder captures the target descriptor and declared type into the outputs "
        "block.",
        "<b>Outcomes:</b> a happy-path run never sees \"member not found\", so outcomes "
        "come from two honest sources: <b>probe runs</b> (re-run discovery with an "
        "exemplar bad input, e.g. memberId=99999; the model calls declare_outcome and "
        "the CLI merges the declared outcome into the existing artifact) and <b>human "
        "review</b> of the artifact JSON, which is designed to be hand-editable. No "
        "hallucinated detectors: declare_outcome is rejected unless its detector text "
        "is visible on screen at the moment of declaration.",
    ]))
    story.append(PageBreak())
    return story
