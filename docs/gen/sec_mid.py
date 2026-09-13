"""Sections 5-9: artifact schema, replay, escalation, safety, evidence."""
from reportlab.platypus import PageBreak

from style import (
    CONTENT_W, H1, H2, H3, P, bull, callout, code, cpb, serves, sp, tbl,
)

# --------------------------------------------------------------------------- 5
SCHEMA_SKELETON = r"""
CapabilityArtifact (v1, as built in core/artifact.ts)  // stored as capabilities/<id>.json
|- schemaVersion: "1.0"                        // format version -> migration path
|- capability: { id, name, description, version (semver) }
|- target:     { appId, surface: "web", entrypoint (templated URL),
|                appFingerprint: { titlePattern?, markers[] } }  // fail fast on drift
|- inputs[]:   { name, type, required, pattern?, enumValues?, sensitive,
|                description?, example? }
|- outputs[]:  { name, type, sensitive, sourceStep, description? }
|- steps[]:    { id, intent, action, target?, url?, value?, key?, sensitive,
|                outputName?, extractPattern?, waitBefore?, checkpoint?,
|                risk: "safe"|"risky" }
|- outcomes[]: { code, description, terminal: true, detector: Condition }
|- recoveries[]: { id, appliesTo: "global"|stepIds[], detector: Condition,
|                  action: dismiss(target) | waitRetry(backoffMs) |
|                          runSteps(stepIds), maxAttempts }
|- successCheckpoint: Condition
|- policy:     { requiredOrigins[], allowedActionKinds[],
|                riskLevel: "readonly"|"mutating", unattendedReplay: boolean }
|- provenance: { provider, model, runId, recordedAt, evidenceRef?,
|                reviewStatus: "draft"|"approved", reviewedBy?, reviewedAt? }

// Zod superRefine cross-checks at parse time: unique step ids, every
// outputs[].sourceStep and recoveries[].appliesTo references a real step.
"""

STEP_EXAMPLE = r"""
{
  "id": "s3",
  "intent": "Enter the member number into the search field",     // model's words, kept
  "action": "fill",
  "target": {
    "strategies": [                                              // ranked, tried in order
      { "kind": "role",      "role": "textbox", "name": "Member Number" },
      { "kind": "labelText", "value": "Member Number" },
      { "kind": "nearText",  "value": "Member Number" },
      { "kind": "css",       "value": "#ctl00_pnlSrch_txtMbr" },  // observed, brittle,
      { "kind": "bbox",      "value": [412, 236, 180, 24] }       //   per-tenant patchable
    ],
    "elementDescription": "Member number input in the search panel",
    "framePath": []                                              // frameset-safe addressing
  },
  "value": "{{inputs.memberId}}",                    // literal 12345 parameterized away
  "waitBefore": { "condition": { "elementVisible": { "kind": "labelText",
                    "value": "Member Number" } }, "timeoutMs": 5000 },
  "checkpoint": { "valueMatches": { "target": { "kind": "labelText",
                    "value": "Member Number" }, "pattern": "{{inputs.memberId}}" } },
  "risk": "safe"
}
"""

CONDITION_AST = r"""
Condition :=                                       // core/conditions.ts, as built
    { "all":   Condition[] }                       // conjunction
  | { "any":   Condition[] }                       // disjunction
  | { "not":   Condition }
  | { "urlMatches":     "<pattern>" }              // template-aware
                                                   //   ("/members/{{inputs.memberId}}")
  | { "textPresent":    "<string>" }
  | { "elementVisible": LocatorStrategy }
  | { "elementAbsent":  LocatorStrategy }
  | { "valueMatches":   { target: LocatorStrategy, pattern } }  // input assertions
"""


def sec5():
    story = [H1("5. Artifact schema - the capability contract")]
    story.append(serves("System design (the stated focal point), robustness, generalization, safety."))
    story.append(P(
        "The artifact is the product of discovery and the input to replay - the brief "
        "calls it a capability an AI agent can call, and says to design the schema "
        "deliberately. The single organizing idea here: <b>separate the contract from "
        "the mechanics from the policy.</b> A calling agent needs only the contract "
        "(what to send, what comes back, which business outcomes exist). The replay "
        "engine consumes the mechanics (steps, targets, waits, checkpoints). The policy "
        "engine reads the policy block. A human reviewer reads all three - which is why "
        "every step keeps the model's stated intent as prose."))
    story.append(H2("5.1 Shape"))
    story.extend(code(SCHEMA_SKELETON, chunk=60))
    story.append(sp(3))
    story.append(P(
        "Appendix A contains the committed artifact for member-savings-lookup, as the "
        "Recorder actually emitted it from a real discovery run. Everything is "
        "Zod-defined in core/; the static types are inferred from the same definitions "
        "that validate at runtime, so an artifact that parses is an artifact the "
        "engine can run. Three capabilities are committed: member-savings-lookup "
        "(read), member-standing-check (read, four result shapes), and subaccount-open "
        "(mutating, 14 steps through a confirmation screen)."))
    story.append(H2("5.2 A step, annotated"))
    story.extend(code(STEP_EXAMPLE, chunk=60))
    story.append(H2("5.3 Target descriptors: ranked, semantic-first locator strategies"))
    story.append(P(
        "Each target carries an ordered list of independent strategies, tried at replay "
        "time until exactly one node matches. The ranking encodes a robustness "
        "argument, not a preference:"))
    story.append(tbl(
        ["Rank", "Strategy", "Why this position"],
        [
            ["1", "role + accessible name",
             "Most stable identity across styling, branding, and markup refactors; "
             "portable to desktop accessibility APIs; it is how a human names the "
             "control (\"the Member Number textbox\")."],
            ["2", "labelText (associated label)",
             "Explicit label-control association; very stable on server-rendered "
             "form-heavy enterprise apps."],
            ["3", "nearText (anchor on visible text)",
             "Legacy tables often have no label association at all - the visible text "
             "near the control is the only semantic anchor. Survives non-semantic "
             "markup; this is the no-clean-DOM workhorse."],
            ["4", "css (as observed)",
             "Precise and fast when it works, but brittle and tenant-specific "
             "(generated IDs). Recorded because it was true at discovery; the natural "
             "slot for per-tenant overrides (Section 10)."],
            ["5", "bbox + elementDescription",
             "Universal last resort; also the bridge to screenshot/vision drivers and "
             "desktop surfaces. Description is for humans and vision models alike."],
        ],
        [28, 118, CONTENT_W - 28 - 118]))
    story.append(sp(3))
    story.append(callout("Uniqueness rule: ambiguity fails closed", [
        "A strategy that matches zero nodes or more than one node is treated as a "
        "miss and the next rank is tried; if all ranks miss, the step raises a "
        "deviation - the engine never guesses among candidates. In a banking "
        "back-office, acting on the wrong control is strictly worse than stopping. "
        "Replay telemetry records which rank matched (fallback depth), which becomes "
        "the drift signal in Section 10.3.",
    ]))
    story.append(sp(2))
    story.append(H2("5.4 Conditions: a small declarative AST"))
    story.append(P(
        "Waits, checkpoints, outcome detectors, and recovery detectors all share one "
        "predicate language:"))
    story.extend(code(CONDITION_AST, chunk=60))
    story.extend(bull([
        "<b>Serializable and reviewable:</b> a checkpoint is data a reviewer can read, "
        "not code that must be trusted; no eval, no injection surface.",
        "<b>Surface-agnostic:</b> every predicate is expressible against web, desktop "
        "accessibility trees, or OCR/vision output - conditions do not name DOM "
        "concepts.",
        "<b>Composable:</b> outcome detectors are just conditions, so \"no records "
        "found banner visible AND results table absent\" is one declaration.",
    ]))
    story.append(H2("5.5 Parameterization and secrets"))
    story.append(P(
        "The Recorder rewrites every occurrence of a declared input's literal value "
        "(in fill values, URLs, and checkpoint patterns) into {{inputs.name}} "
        "references - which is simultaneously the reuse mechanism and the reason raw "
        "customer data never lands in an artifact. Credentials never appear even at "
        "discovery time: login steps reference {{secrets.tellerPassword}}, resolved "
        "from the environment at runtime, and marked so evidence masks them. "
        "Sensitive-flagged inputs and outputs are masked in every log line and "
        "screenshot (Section 8.3)."))
    story.append(H2("5.6 Versioning and review lifecycle"))
    story.extend(bull([
        "<b>schemaVersion</b> versions the format (migrations); "
        "<b>capability.version</b> (semver) versions the flow - a locator patch is a "
        "patch bump, a changed contract (inputs/outputs/outcomes) is a major bump "
        "because callers depend on it.",
        "<b>appFingerprint</b> pins what the flow was recorded against; replay "
        "verifies it up front and fails fast with DRIFT_SUSPECTED rather than acting "
        "on a changed app.",
        "<b>reviewStatus: draft -> approved</b> is set by a human after reading the "
        "artifact (npm run approve -- --capability <id> --reviewer <name> stamps "
        "reviewedBy and reviewedAt; the JSON diff is a git PR review). Risky "
        "capabilities cannot replay unattended while in draft - the approval state is "
        "enforced by the policy engine, not by convention.",
    ]))
    story.append(H2("5.7 Alternatives rejected"))
    story.append(tbl(
        ["Alternative", "Why rejected"],
        [
            ["Record a runnable script (generated Playwright code)",
             "Not reviewable as data, not parameterizable without parsing code, no "
             "seam for policy checks or outcome declarations, and locked to one "
             "surface technology. Code generation from the artifact is the right "
             "direction (a stretch goal), not the storage format."],
            ["Store the raw LLM transcript as the artifact",
             "The brief explicitly requires decoupling. Transcripts are "
             "nondeterministic, unreviewable, and full of raw page content (PII). "
             "Provenance keeps a pointer to the run, not the transcript."],
            ["Single flat step list without declared outcomes/recoveries",
             "Forces every deviation to be a failure - precisely the business-outcome/"
             "failure conflation the brief warns is the most common design mistake."],
            ["One monolithic locator per element",
             "A single selector is a single point of failure and gives no cross-tenant "
             "story; ranked strategies degrade gracefully and make drift measurable."],
        ],
        [150, CONTENT_W - 150]))
    story.append(PageBreak())
    return story


# --------------------------------------------------------------------------- 6
REPLAY_ALGO = r"""
replay(artifact, params):
  validate params against artifact.inputs (Zod)          // typed at the boundary
  policy.load(artifact.policy + global policy.yaml)
  driver.open(render(artifact.target.entrypoint))
  assert appFingerprint                                  // else DRIFT_SUSPECTED hard fail

  for step in artifact.steps:
    waitFor(step.waitBefore, bounded)                    // named condition, never sleep()
    guardScan()                                          // cheap global detectors: known
                                                         //   dialogs, session-expiry marker
    handle = resolve(step.target)                        // ranked; unique-or-next-rank;
                                                         //   records fallbackDepth
    driver.act(step.action, handle, render(step.value))  // PolicyEngine check inside act()
    ok = verify(step.checkpoint, bounded)
    if deviation (resolve miss | act error | checkpoint fail | guard hit):
        classify(snapshot):
          1. matches artifact.outcomes[].detector  -> return BUSINESS_OUTCOME(code)
          2. matches recoveries[].detector         -> apply recovery, retry step
                                                      (bounded by maxAttempts)
          3. else                                  -> evidence bundle;
                                                      escalate if policy allows;
                                                      else return HARD_FAILURE(step,
                                                        expected, observed, evidence)

  outputs = extract(artifact.outputs)                    // from declared source steps
  verify(artifact.successCheckpoint, bounded)            // else classify as above
  return SUCCESS(outputs, telemetry)
"""

RESULT_CONTRACT = r"""
// core/result.ts, as built: RunOutcome, a Zod discriminated union on status.
type RunOutcome =
  | { status: "success";          outputs: Record<string, string> }
  | { status: "business_outcome"; code: string;           // e.g. "MEMBER_NOT_FOUND"
      description: string; extracted: Record<string, string> }
  | { status: "hard_failure";     error: { stepId?, intent?, expected: string,
      observed: string, evidence: string[] } }            // paths into the run dir
  | { status: "escalated";        interventions: InterventionSummary[];   // >= 1
      finalStatus: "success" | "business_outcome" | "hard_failure" | "aborted";
      outputs?; code?; description?; extracted?; error? };
      // ^ the underlying result is carried through the escalation wrapper

// InterventionSummary: { id, reason, type: "assist" | "approval",
//   disposition: fixed_environment | completed_step | approve_once | deny
//              | abort | expired,  operator? }
//
// The RunResult wrapper adds: runId, mode, capability id + version, params
// (sensitive values pre-masked), timestamps, evidenceDir, and per-step
// telemetry: { stepId, strategyRank (0 = primary; rising = locator drift),
// strategyKind, targeted, attempts, recoveriesApplied[], durationMs }.
// Business conditions are values, not thrown errors.
"""


def sec6():
    story = [H1("6. Deterministic replay and the error taxonomy")]
    story.append(serves("Correctness of the core loop, robustness and error handling (criteria 2-3)."))
    story.append(P(
        "Replay is the production path: given an artifact and typed params, execute "
        "the flow with <b>no model in the decision loop</b> and return a structured "
        "result. The engine's design goal is honesty under deviation - the brief is "
        "explicit that the interesting failures are runtime conditions, not layout "
        "drift, and that a replay must respond deliberately rather than blindly "
        "proceed."))
    story.append(H2("6.1 Execution algorithm"))
    story.extend(code(REPLAY_ALGO, chunk=44))
    story.append(sp(3))
    story.append(H2("6.2 Wait and checkpoint strategy"))
    story.extend(bull([
        "<b>No sleeps, ever.</b> Every wait is a named condition with a bounded "
        "timeout, recorded in the artifact from what discovery actually observed "
        "(URL changed, element appeared). Playwright's actionability checks "
        "(visible/enabled/stable) cover the last mile before each action.",
        "<b>A checkpoint after every step</b>, not only at the end. Rationale: it "
        "bounds the blast radius of a silent failure to one step, makes the failing "
        "step the unit of debugging (what was expected vs observed, right there), and "
        "gives the resume logic after human handoff a precise re-entry test "
        "(Section 7.5).",
        "<b>A final successCheckpoint</b> asserts the business goal itself (e.g. the "
        "balance panel for that member is visible) so success is verified, never "
        "assumed - the glossary's definition of a checkpoint.",
        "<b>Guard scans between steps</b> run a handful of cheap global detectors "
        "(known interstitial, session-expiry marker, error banner) so an unexpected "
        "dialog is caught at the seam where it appears, not three steps later as a "
        "confusing resolve failure.",
    ]))
    story.append(H2("6.3 The three-class taxonomy, applied to the brief's own conditions"))
    story.append(tbl(
        ["Runtime condition", "Class", "Replay response", "What the caller sees"],
        [
            ["Record / member not found", "Business outcome",
             "Detector matches; extract any declared fields; stop cleanly.",
             "status=business_outcome, code=MEMBER_NOT_FOUND"],
            ["Validation error on a form", "Business outcome (declared)",
             "Detector matches the field-error state; committed example: the "
             "sub-account form rejecting a low deposit.",
             "code=DEPOSIT_BELOW_MINIMUM"],
            ["Permission denied", "Business outcome (terminal)",
             "Legitimate state the caller must know; never retried.",
             "code=PERMISSION_DENIED"],
            ["Known interstitial dialog (e.g. maintenance notice)", "Recoverable",
             "Declared recovery dismisses it; step retried; recovery logged.",
             "Success (telemetry shows the recovery)"],
            ["Transient slowness / failed load", "Recoverable",
             "Bounded wait-and-retry with backoff (maxAttempts).",
             "Success, or hard failure once bounds exhaust"],
            ["Session timeout / expiry", "Recoverable (bounded) or escalate",
             "A declared runSteps recovery re-runs the login steps ({{secrets.*}} "
             "resolved from env); otherwise intervention.",
             "Success after re-auth, or status=escalated"],
            ["Unexpected unknown dialog", "Hard failure -> escalate",
             "No detector matches: never dismiss what we cannot name.",
             "status=escalated (or hard_failure with evidence)"],
            ["App error / HTTP 500", "Hard failure",
             "Evidence bundle (screenshot, a11y snapshot, URL, console); stop.",
             "status=hard_failure with step, expected, observed"],
            ["Ambiguous or missing target", "Hard failure",
             "All strategy ranks missed or matched multiple nodes; fail closed.",
             "status=hard_failure (+ DRIFT_SUSPECTED hint)"],
        ],
        [118, 82, 152, CONTENT_W - 118 - 82 - 152]))
    story.append(sp(4))
    story.append(callout("Why classification runs in this exact precedence", [
        "<b>Outcomes before recoveries:</b> an expected business state must never be "
        "\"recovered\" away - retrying a not-found lookup is at best wasteful and at "
        "worst masks the caller's answer.",
        "<b>Recoveries before failure:</b> only conditions someone declared and "
        "bounded (maxAttempts) are recoverable; recovery is a whitelist, not a "
        "heuristic.",
        "<b>Failure is the default:</b> anything unrecognized fails closed with "
        "evidence. The classifier evaluates detectors against one stable snapshot so "
        "the decision itself is deterministic.",
    ]))
    story.append(sp(2))
    story.append(H2("6.4 Result contract"))
    story.extend(code(RESULT_CONTRACT, chunk=44))
    story.append(sp(3))
    story.append(P(
        "One deliberate property of the escalated arm: it wraps the underlying result "
        "rather than replacing it. A run that needed a human still returns its business "
        "answer - the committed escalation evidence ends in finalStatus=success with "
        "outputs, plus the intervention record of who helped and how. Callers that "
        "only care about the answer read finalStatus; callers that audit read the "
        "interventions array."))
    story.append(H2("6.5 What determinism means here"))
    story.append(P(
        "Same artifact + same params + same app state produces the same action "
        "sequence and the same classification. Controlled: no model calls (enforced "
        "by the import-boundary lint on replay/); branching only through declared "
        "detectors; fixed viewport on the browser context; "
        "template rendering is pure. Allowed to vary: timing within bounded waits and "
        "which locator rank matched - both are recorded as telemetry, not silent. "
        "UI drift - secondary per the brief - surfaces as rising fallback depth or a "
        "fingerprint mismatch and is reported as DRIFT_SUSPECTED rather than "
        "misclassified as a random failure."))
    story.append(PageBreak())
    return story


# --------------------------------------------------------------------------- 7
STATE_MACHINE = r"""
                raise intervention              operator claims
   +-----------+                  +-----------+                  +-----------+
   |   AGENT   |----------------->|   PAUSED  |----------------->|   HUMAN   |
   |  running  |(reason + context)|  awaiting |  (token moves)   |  operator |
   |           |                  |   claim   |                  |   drives  |
   +--+-----+--+                  +-----------+                  +-----+-----+
      |     ^                                                          |
      |     |        resume(disposition) after re-verification         |
      |     +----------------------------------------------------------+
      v
   [ terminal: success | business_outcome | hard_failure | escalated ]

   HUMAN handback: resume(fixed_environment | completed_step) -> AGENT;
   abort, or operator completed the goal (verified) -> terminal (escalated).
"""

INTERVENTION_JSON = r"""
// Committed: evidence/replay_escalation_20260912180848/interventions.json
{
  "request": {
    "id": "iv_replay_escalation_20260912180848_1",
    "runId": "replay_escalation_20260912180848",
    "type": "assist",                          // or "approval" for risky steps
    "capabilityId": "member-savings-lookup",
    "reason": "urlMatches(/desk) — observed: checkpoint not satisfied",
    "stepId": "s4",
    "intent": "Sign in to teller system",
    "currentUrl": "http://localhost:4600/login?expired=1",
    "screenshotPath": "screenshots/004_s4_intervention.png",
    "requestedAt": "2026-09-12T18:08:52.174Z",
    "expiresAt": "2026-09-12T18:38:52.174Z"    // TTL (30 min policy default);
  },                                           //   a claim stops the clock
  "status": "resolved",             // pending -> claimed -> resolved | expired
  "claimedBy": "operator-jsmith",
  "claimedAt": "2026-09-12T18:08:52.221Z",
  "resolution": {
    "disposition": "completed_step",
    "operator": "operator-jsmith",
    "note": "re-authenticated in the live session; step's own checkpoint
             should now hold"
  },
  "resolvedAt": "2026-09-12T18:08:52.299Z"
}   // resolved records also carry an HMAC signature block — Section 7.6
"""


def sec7():
    story = [H1("7. Escalation and human-in-the-loop handoff")]
    story.append(serves("Human-in-the-loop escalation (criterion 4) - a real mechanism, not a TODO."))
    story.append(P(
        "The design centers on one idea: <b>control of a live session is an owned "
        "token with an auditable state machine</b>, not an ad-hoc pause. At any moment "
        "exactly one party may act - the automation or a named human - and every "
        "transition is logged with who, when, and why. The same mechanism serves both "
        "uses the brief names: stuck states and risky-action approvals."))
    story.append(H2("7.1 Detecting \"stuck\""))
    story.append(tbl(
        ["Phase", "Trigger"],
        [
            ["Discovery", "Loop detection (same action + same state hash three times); "
             "max steps or wall-clock budget exceeded; the model itself calls "
             "escalate(reason); PolicyEngine blocks a risky action the model "
             "requested."],
            ["Replay", "DeviationClassifier reaches class 3 (no outcome, recoveries "
             "exhausted or none apply): unknown dialog, failed checkpoint, ambiguous "
             "target, app error. Escalation is attempted before returning a hard "
             "failure when policy allows an operator."],
            ["Approval", "A step marked risk=risky requires confirmation "
             "(discovery: always; replay: whenever unattendedReplay is false or "
             "reviewStatus is draft). Raised as an intervention of type approval - "
             "same pipeline, different disposition set (approve_once / deny)."],
        ],
        [70, CONTENT_W - 70], bold_first_col=True))
    story.append(sp(4))
    story.append(H2("7.2 Control-ownership state machine"))
    story.extend(code(STATE_MACHINE, chunk=60))
    story.append(P(
        "The automation loop physically cannot act while it does not hold the token: "
        "the RunController exposes an awaitControl() gate the executor passes through "
        "before every step, and the driver tags every action with the current holder. "
        "This is the seam the brief asks about - pause, cede, resume on the same "
        "session - expressed as a mutex plus a state machine rather than convention. "
        "As built, custody history is also <b>tamper-evident</b>: every transition is "
        "written to run.jsonl as a control_transition event carrying the head of a "
        "runId-seeded SHA-256 hash chain, so editing any historical transition breaks "
        "every chain hash recorded after it."))
    story.append(H2("7.3 The intervention request"))
    story.extend(code(INTERVENTION_JSON, chunk=44))
    story.append(H2("7.4 Taking control of the live session"))
    story.extend(bull([
        "The browser runs <b>headed</b>; the session (cookies, storage, page state) "
        "is the one the automation was using - not a fresh context.",
        "The <b>operator console</b> (a deliberately minimal local web page, "
        "localhost:4700) lists open interventions with full context: capability, "
        "step and intent, reason, screenshot, current URL. Claiming one flips the "
        "state machine to HUMAN and hands the operator the token. Every console "
        "route requires a bearer token (x-scribe-token header, or ?token= in the "
        "CLI-printed URL for the dashboard), compared timing-safe; set "
        "SCRIBE_CONSOLE_TOKEN for a stable token, otherwise each run mints a fresh "
        "random one.",
        "The operator acts <b>directly in the same browser window</b>. An injected "
        "recorder (a page binding capturing clicks, fills, and navigations, with "
        "values redacted) writes each human action into the same evidence stream "
        "with actor=\"human\" - so the record of what the human did survives the "
        "handoff, as required.",
        "<b>Production design (documented, not built):</b> for remote operators the "
        "same token model rides on CDP screencast or noVNC to a browser pool; the "
        "console gains a live view. Nothing in the artifact, engine, or state "
        "machine changes - only the transport for human input. This is the "
        "deliberate mock seam the brief invites.",
    ]))
    story.append(H2("7.5 Handback and resume semantics"))
    story.append(tbl(
        ["Disposition", "Meaning", "Engine behavior on resume (as built)"],
        [
            ["fixed_environment", "\"I repaired the state (e.g. re-logged-in); the "
             "step never completed.\"",
             "Checkpoint-first: if the operator's fix already restored the step's "
             "postcondition, re-acting would double-apply it, so the engine advances; "
             "otherwise the step is retried from its waitBefore."],
            ["completed_step", "\"I performed this step manually.\"",
             "Verify the current step's checkpoint against the live session; pass "
             "means advance, fail means hard failure (\"operator marked the step "
             "complete but its checkpoint still fails\") - never re-execute a "
             "mutating step a human already did."],
            ["approve_once / deny", "Decision on a risky-action approval request.",
             "approve_once is consumed by exactly one executed act attempt - a retry "
             "of the same step must re-ask; deny classifies the run as blocked and "
             "stops with a clear result."],
            ["abort", "\"This run should not continue.\"",
             "Terminal: result status escalated with finalStatus=aborted, evidence "
             "sealed."],
            ["expired", "Nobody claimed the intervention before its TTL.",
             "Fail closed: the run ends escalated with finalStatus=aborted. A claim "
             "stops the clock, so a human actively working is never timed out."],
        ],
        [86, 150, CONTENT_W - 86 - 150], bold_first_col=True))
    story.append(sp(4))
    story.append(callout("Why checkpoints make resume safe", [
        "Resume never trusts the human's claim: it trusts the artifact's per-step "
        "checkpoints, evaluated against the live session. The human says what they "
        "intended; the engine verifies what is true. This is also why per-step "
        "checkpoints (Section 6.2) are non-negotiable in the schema: they are the "
        "re-entry tests for handoff, not just failure locators.",
    ]))
    story.append(sp(2))
    story.append(H2("7.6 Tamper-evident dispositions (built)"))
    story.append(P(
        "A resolution record (\"this operator approved this risky step\") is an "
        "accountability artifact; anyone with write access to the evidence directory "
        "could otherwise edit it after the fact. As built, every operator disposition "
        "is <b>HMAC-SHA256 signed</b> over a domain-separated, fixed-order canonical "
        "payload (domain scribe.resolution.v2) binding interventionId, runId, "
        "capabilityId, stepId, disposition, operator, note, resolvedAt, <b>and the "
        "control-chain head at the moment of hand-back</b> - so a signature for "
        "\"approve step s13 of subaccount-open in run X\" cannot be replayed against, "
        "or reinterpreted as, anything else, and is pinned to the exact custody "
        "history it happened under."))
    story.extend(bull([
        "<b>Auditor check:</b> verifyResolutionForRecord() recomputes the payload "
        "from the <i>stored</i> record and verifies the MAC against that - editing "
        "resolution.note or request.capabilityId in interventions.json fails "
        "verification even if the signature object itself is left untouched.",
        "<b>Key handling:</b> the signing key comes from SCRIBE_SIGNING_SECRET "
        "(defaulting to the console token), identified in the record by a "
        "fingerprint keyId; comparisons are timing-safe.",
        "<b>Honest scope cut:</b> HMAC with one shared key means verifier = trusted "
        "auditor holding the key. Production swaps in per-operator identity (OIDC) "
        "and KMS-held asymmetric keys behind the same seam; nothing outside the "
        "signing module knows the algorithm.",
    ]))
    story.append(PageBreak())
    return story


# --------------------------------------------------------------------------- 8
def sec8():
    story = [H1("8. Safety and data handling")]
    story.append(serves("Safety and data handling (criterion 6); also constrains discovery and replay design."))
    story.append(H2("8.1 One chokepoint, physically unavoidable"))
    story.append(P(
        "The PolicyEngine is invoked <b>inside SurfaceDriver.act()</b> - not by the "
        "callers. Discovery, replay, and any future assisted-recovery path all act "
        "through the driver, so no code path can reach the UI without passing policy. "
        "This placement is the design's single most important safety property: "
        "enforcement by construction rather than by caller discipline. (The alternative "
        "- each runner checking policy before calling the driver - fails open the day "
        "someone adds a third caller.)"))
    story.append(H2("8.2 The allowlist model (deny by default)"))
    story.extend(bull([
        "<b>Origins and routes:</b> navigation and actions are permitted only on "
        "origins/URL patterns listed in policy.yaml plus the artifact's "
        "requiredOrigins. Anything else is blocked and logged - during discovery the "
        "model is told its action was policy-blocked (it must find another way or "
        "escalate), during replay the block is a hard failure with evidence.",
        "<b>Action kinds:</b> the global config and each artifact declare which of "
        "navigate/click/fill/select/press/extract are permitted; e.g. a read-only "
        "capability that suddenly needs a submit fails policy, which catches both "
        "drift and tampering.",
        "<b>Budgets:</b> max steps, per-step and per-run timeouts, and max recovery "
        "attempts are policy, so runaway loops are structurally impossible.",
    ]))
    story.append(H2("8.3 Risky and irreversible actions"))
    story.append(P(
        "Every step carries risk: safe or risky, assigned at recording (mutating "
        "submits, anything past a confirmation screen) and reviewable. Handling is "
        "conservative and justified by asymmetry: a blocked action costs seconds of "
        "operator time; a wrong irreversible write in a banking system has unbounded "
        "cost. Concretely: during discovery, risky actions always require a human "
        "approval (the intervention pipeline); during replay, risky steps run "
        "unattended only when the artifact is reviewStatus=approved AND its policy "
        "sets unattendedReplay=true - otherwise the run pauses for approval. Reads "
        "never require approval."))
    story.append(H2("8.4 Redaction pipeline (regulated financial data)"))
    story.append(tbl(
        ["Layer", "Mechanism"],
        [
            ["Artifacts", "Recorder parameterization replaces literal input values "
             "with {{inputs.*}} references; sensitive example values are never "
             "stored; credentials exist only as {{secrets.*}} references resolved "
             "from the environment at runtime."],
            ["Logs", "The evidence logger applies redaction before write: values of "
             "sensitive-flagged params/outputs and any {{secrets.*}} resolution are "
             "masked (never logged in the clear, anywhere) - including URL-encoded "
             "variants, so a secret embedded in a query string is caught too."],
            ["Screenshots", "Steps that touch sensitive-flagged fields are captured "
             "with Playwright's mask option over those locators; a per-step "
             "screenshot=off escape hatch exists for fully sensitive screens."],
            ["LLM transcript", "Not persisted. Provenance stores model, provider, "
             "runId, and distilled per-step intents - the decoupling the brief "
             "requires - so page content containing PII does not outlive the run."],
            ["Repo hygiene", "No secrets in the repo: .env.example documents required "
             "keys; the mock app ships only synthetic data."],
        ],
        [70, CONTENT_W - 70], bold_first_col=True))
    story.append(sp(4))
    story.append(H2("8.5 The network-layer backstop (added during implementation)"))
    story.append(P(
        "The act() chokepoint refuses to <i>initiate</i> off-allowlist actions - but a "
        "malicious or compromised page can initiate traffic by itself: tracker pixels, "
        "scripted navigations, server-side redirects. Implementation therefore added a "
        "second enforcement line at the network layer, inside the driver, and it is "
        "the one place where building the system overturned the original design:"))
    story.extend(bull([
        "<b>Route interception:</b> every request in the browser context passes a "
        "context.route handler; requests to off-allowlist origins are aborted "
        "in-flight and logged as net_blocked events - the request never leaves the "
        "browser. This covers page-initiated subresources and link navigations alike.",
        "<b>Server redirects vetted at the source:</b> the handler fetches with "
        "maxRedirects: 0 and vets the first Location header; an off-allowlist "
        "destination is replaced with a synthetic 502 blocking response, so the "
        "browser never follows it and the run stays on the allowlisted origin.",
        "<b>The uninterceptable hop:</b> Playwright route handlers are never "
        "re-invoked for deeper hops of a redirect chain (verified empirically: when a "
        "handler fulfills a 3xx, the browser follows it on the direct network path). "
        "A request-stream watchdog catches any redirectedFrom() hop whose URL leaves "
        "the allowlist, records the violation, and tears the browser context down - "
        "the run fails closed. This is detection-and-kill, not prevention: one hop's "
        "egress can race the teardown, a residual that is documented and asserted "
        "as such in the integration tests rather than papered over.",
        "<b>A rejected fix, on the record:</b> probing chain hops from Node before "
        "letting the browser proceed looked airtight but executes every hop twice - "
        "which corrupts one-shot server state. The mock app's armed session-expiry "
        "fault fired on the probe, the browser never saw the expiry, and four "
        "integration tests failed; first-hop vetting plus the watchdog replaced it. "
        "Chain-walking a stateful server from outside the browser is a design error.",
        "<b>Side channels closed:</b> service workers are blocked at context "
        "creation (no script-controlled fetch layer outside the routes) and "
        "WebSockets are denied wholesale (closed with policy code 1008) - policy "
        "cannot vet a full-duplex stream, so it refuses it.",
    ]))
    story.append(cpb(120))
    story.append(H2("8.6 Prompt-injection stance and honest limits"))
    story.extend(bull([
        "Page content is <b>untrusted input</b>: the agent's system prompt instructs "
        "the model to treat on-screen text as data, but the real guarantee is "
        "structural - whatever the model asks for, the allowlist and risk gates hold "
        "at the chokepoint. A page cannot talk the system into acting off-policy; at "
        "worst it wastes bounded steps.",
        "<b>Limits stated plainly:</b> redaction is flag-driven, not a DLP scanner - "
        "an unflagged sensitive field would leak into evidence until review catches "
        "it; screenshot masking is best-effort on legacy layouts; the mock app's "
        "auth is synthetic. These are documented in REPORT.md's Safety section "
        "rather than papered over.",
    ]))
    story.append(cpb(170))
    story.append(H2("8.7 policy.yaml (excerpt; committed file in Appendix C)"))
    story.extend(code(
        "allowlist:\n"
        "  origins:\n"
        "    - http://localhost:4600   # mock CU back-office - tenant A\n"
        "    - http://localhost:4650   # re-skinned tenant B (CU North)\n"
        "actionKinds: [navigate, click, fill, select, press, extract]\n"
        "risky:\n"
        "  discoveryRequiresConfirmation: true       # human approves every mutation\n"
        "  unattendedRequiresApprovedArtifact: true  # risky replay needs review\n"
        "budgets: { discoveryMaxTurns: 40, stepTimeoutMs: 15000,\n"
        "           runTimeoutMs: 300000, maxStepAttempts: 3 }\n"
        "escalation: { operatorPort: 4700, interventionTtlMinutes: 30 }\n"
        "redaction:\n"
        "  maskReplacement: \"***\"\n"
        "  extraSecretEnvPrefixes: [\"SCRIBE_SECRET_\"]"))
    story.append(PageBreak())
    return story


# --------------------------------------------------------------------------- 9
EVIDENCE_TREE = r"""
evidence/                             # 18 committed run directories
  disc_20260912173144/                # real discovery recording (OpenAI gpt-4o)
    run.jsonl                         # every event; record shape below
    screenshots/001_... .png          # per turn + outcome + stuck captures
    artifact.json                     # what the Recorder emitted
    discovery-summary.json
  disc_20260912173538/                # outcome probe: declare_outcome run
    outcome.json                      #   merged into the artifact by the CLI
  ... 5 more disc_* dirs              # probes + recordings for the other
                                      #   two capabilities
  replay_20260912173725/              # happy path (success)
    run.jsonl / result.json / artifact.json / screenshots/
  replay_20260912173732/              # business outcome: MEMBER_NOT_FOUND
  replay_20260912173739/              # injected interstitial -> recovery -> success
  replay_20260913015019..45/          # standing check: Active, Dormant,
                                      #   ACCESS_DENIED, MEMBER_NOT_FOUND
  replay_20260913015057/              # risky submit -> approve_once -> escalated,
                                      #   finalStatus success (confirmation no.)
  replay_20260913015112/              # validation outcome carried through
                                      #   escalation: DEPOSIT_BELOW_MINIMUM
  replay_20260913151918/              # cross-tenant replay on CU North (:4650)
  replay_escalation_20260912180848/   # session expiry -> human -> resumed
    interventions.json                # request + claim + disposition
    run.jsonl                         # actor:"human" entries + control chain

run.jsonl record (as built):
  { seq, ts, actor: "agent"|"replay"|"human"|"operator"|"system",
    type, ...event-specific fields }
  // event types include: run_start, act_click/act_fill/act_navigate (with
  // intent + target), step_start/step_done, checkpoint evaluations,
  // recovery_applied, outcome_declared, net_blocked, control_transition
  // (with chainHash), human_action, intervention_resolved, run_finished
"""


def sec9():
    story = [H1("9. Evidence and observability")]
    story.append(serves("Evidence requirement 3.5; also what makes every other claim verifiable."))
    story.append(P(
        "Every run - discovery, replay, or escalated - writes one self-contained "
        "directory: a structured JSONL event log (what happened and, during "
        "discovery, why the model chose it), screenshots at each step, checkpoint, "
        "and failure, machine-readable results, and any intervention records. The "
        "log is append-only and every entry is attributed to an actor, so a run that "
        "crossed a human handoff reads as one continuous, auditable story. All "
        "writes pass through the redacting logger (Section 8.4)."))
    story.extend(code(EVIDENCE_TREE, chunk=44))
    story.append(P(
        "Eighteen run directories are committed: seven discovery runs (the real "
        "recordings plus the outcome probes that declared MEMBER_NOT_FOUND, "
        "ACCESS_DENIED, and DEPOSIT_BELOW_MINIMUM), ten replays exercising every arm "
        "of the taxonomy - happy paths, both terminal business outcomes, an "
        "interstitial recovery, a risky approve_once run, a validation outcome "
        "carried through escalation, and a cross-tenant replay on the second tenant "
        "app - and one escalated run with a live human hand-off. Beyond the raw "
        "record, the telemetry is consumed: npm run health aggregates strategy ranks, "
        "recoveries, and durations across evidence/ into a per-capability "
        "locator-health drift report (Section 10.3)."))
    story.append(sp(2))
    return story
