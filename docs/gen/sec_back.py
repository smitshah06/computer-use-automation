"""Sections 10-15 and appendices (as-built revision)."""
from reportlab.platypus import PageBreak

from style import (
    CONTENT_W, H1, H2, P, bull, callout, code, cpb, serves, sp, tbl,
)

# -------------------------------------------------------------------------- 10
DRIVER_IFACE = r"""
// src/surface/types.ts (condensed) - the seam, exactly as built
export interface SurfaceDriver {
  launch(): Promise<void>;   // fresh session; entry navigation goes through act()
  close(): Promise<void>;

  observe(): Promise<Observation>;   // { url, title, nodes: UiNode[], pageText }

  // Replay path: resolve a recorded target through its ranked strategies.
  // Exactly one element must match; ambiguity fails closed.
  resolve(target: StepTarget, opts?): Promise<ResolveOutcome>;

  // The single gate through which every state-changing interaction passes.
  // The PolicyEngine is consulted INSIDE this method (the chokepoint).
  act(req: ActionRequest & { ref?: string }): Promise<ActResult>;

  synthesizeTarget(ref: string): Promise<TargetSynthesis | null>;  // discovery -> artifact

  evalCondition(cond: Condition): Promise<boolean>;
  waitForCondition(cond: Condition, timeoutMs: number): Promise<boolean>;

  // Human-control window: operator clicks/inputs in the live session are
  // reported (password values masked at the source) for the audit trail.
  startHumanCapture(onEvent: (e: HumanActionEvent) => void): Promise<void>;
  stopHumanCapture(): Promise<void>;

  url(): string;  title(): Promise<string>;  screenshot(absPath: string): Promise<void>;
}

export interface UiNode {                 // the surface-agnostic observation unit
  ref: string;                            // ephemeral, valid for this observation only
  role: string;  name: string;  value?: string;
  disabled?: boolean;  checked?: boolean;
  bbox: [number, number, number, number];
  framePath: string[];                    // window/frame/pane addressing
}
"""

TENANT_BINDING = r"""
{
  "schemaVersion": "1.0",
  "tenantId": "cu-north",
  "appId": "cu-backoffice",        // must match the base artifact, or the merge refuses
  // description (re-wrapped): CU North runs the same teller product re-branded
  // as "CU North TellerWorks" - green skin, tw_* auto-generated ids, and
  // member->customer vocabulary. Routes, forms, and business behavior are
  // identical, so the recorded artifacts replay here through this overlay
  // alone - no re-recording.
  "requiredOrigins": ["http://localhost:4650"],
  "appFingerprint": {
    "titlePattern": "CU North TellerWorks",
    "markers": ["Operator Log On"]
  },
  "vocabulary": {
    "Teller Sign-In": "Operator Log On",
    "Teller ID": "Operator ID",
    "Passcode": "PIN",
    "Sign In": "Log On",
    "Teller Desk": "Operator Desk",
    "Member Search": "Customer Search",
    "Member Number": "Customer Number",
    "Search": "Find",
    "Member Results": "Customer Results",
    "Member Profile": "Customer Profile",
    "Member No": "Customer No",
    "Member Since": "Customer Since",
    "No records found": "No matching customers on file",
    "No records found.": "No matching customers on file."
  }
}
"""


def sec10():
    story = [H1("10. Heterogeneity and multi-tenant reuse")]
    story.append(serves("Generalization to the real environment (criterion 5). The multi-tenant overlay is"
                        " built and demonstrated - a cross-tenant replay is committed evidence; the extra"
                        " surface drivers remain design, per the brief's instruction."))
    story.append(H2("10.1 The surface seam"))
    story.append(P(
        "One sentence carries the whole abstraction: <b>the artifact records what to "
        "find and verify (semantic descriptors and declarative conditions); the driver "
        "owns how to perceive and act.</b> Nothing in the artifact names a DOM, a "
        "selector engine, or a browser - so extending to a new surface means writing "
        "a driver, not re-recording capabilities."))
    story.extend(code(DRIVER_IFACE, chunk=44))
    story.append(tbl(
        ["Surface", "How the same artifact executes"],
        [
            ["Modern web (built)", "PlaywrightDriver: a11y snapshot for observe; "
             "role/label/text engines for resolve; DOM events for act."],
            ["Legacy web (built - the mock app is deliberately this)", "Same driver - "
             "resolution simply lands lower in the strategy ranking (nearText, "
             "css, bbox) because roles/labels are sparse. framePath addresses "
             "framesets. No schema change.",],
            ["Desktop (designed)", "UIA (Windows) / AXUIElement (macOS) driver: the "
             "OS accessibility tree maps onto the same UiNode shape - the glossary "
             "itself notes a11y trees exist on desktop. role+name strategies carry "
             "over; css ranks are simply skipped."],
            ["Screenshot-only / hostile (designed)", "Vision driver: observe via "
             "OCR + detection into UiNode[]; resolve uses elementDescription plus "
             "the recorded bbox rank (captured on every targeted step for exactly "
             "this); act by coordinates. A model assists <b>perception only</b> - "
             "decisions stay deterministic, and the policy chokepoint is unchanged."],
        ],
        [128, CONTENT_W - 128], bold_first_col=True))
    story.append(sp(4))
    story.append(H2("10.2 Multi-tenant reuse: base artifact + tenant binding overlay (built)"))
    story.append(P(
        "Hundreds of institutions run the same vendor product, differently branded and "
        "versioned. Re-recording per tenant is the failure mode to avoid, so the unit "
        "of recording is the <b>vendor product</b> (base artifact), and each tenant "
        "contributes only a thin, reviewable <b>binding</b>. This is no longer just a "
        "schema - below is the committed tenants/cu-north.json that the cross-tenant "
        "demo runs through (description re-wrapped as a comment):"))
    story.extend(code(TENANT_BINDING, chunk=44))
    story.extend(bull([
        "<b>Merge at load, never mutate the base:</b> replay --tenant cu-north "
        "resolves base + binding into an effective artifact in memory, and the merged "
        "result is re-validated through the same strict artifact schema - a bad "
        "overlay cannot smuggle in an invalid capability. One upgrade path, many "
        "tenants.",
        "<b>Vocabulary is exact-match on whole strings,</b> applied to role names, "
        "labelText/nearText values, textPresent detectors, and element descriptions - "
        "never to css, bbox, urlMatches, step values, or extract patterns. \"Member "
        "Search\" -> \"Customer Search\" cannot mangle \"Member Number\", and "
        "mechanics stay untouched: only identification vocabulary shifts.",
        "<b>stepOverrides replace a step's strategy list wholesale</b> - no partial "
        "patching to reason about - and vocabulary deliberately skips overridden "
        "steps: an override is already tenant-final.",
        "<b>Bindings carry no flow logic:</b> a tenant cannot fork behavior, only "
        "identification and configuration. A tenant needing a different flow is a "
        "new capability version, reviewed like any other.",
        "<b>Fails closed:</b> an appId mismatch refuses the merge (never across "
        "products); unknown step ids are errors; and without --tenant the artifact's "
        "requiredOrigins still pin tenant A, so tenant B's origin is denied at the "
        "chokepoint. test/integration/tenant.test.ts proves both directions.",
    ]))
    story.append(P(
        "The committed cross-tenant run (evidence/replay_20260913151918) replays the "
        "artifact recorded on tenant A against CU North through this overlay alone - "
        "no re-recording, no LLM. Its telemetry shows every step resolving at rank 0 "
        "(role/labelText/nearText): tenant A's ctl00_* css ranks never had to match "
        "the tw_* markup. That is the semantic-first locator thesis (Section 5) doing "
        "exactly the work it was designed for."))
    story.append(H2("10.3 Detecting and managing drift"))
    story.extend(bull([
        "<b>Telemetry as sensor (built):</b> every replay records, per step, which "
        "strategy rank matched (0 = primary), the strategy kind, attempts, recoveries "
        "applied, and duration - committed in every result.json. npm run health "
        "aggregates the evidence corpus into a per-capability locator-health report; "
        "--ci exits non-zero when a capability is drifting or broken. The committed "
        "standing-check runs already show a real drift signature: replayed against a "
        "different member than it was recorded on, step s8 falls from the "
        "recorded-name rank to the parameterized nearText rank - visible in telemetry "
        "long before anything breaks.",
        "<b>Fail fast on version drift (built):</b> the appFingerprint preflight "
        "stops the run before any action when the app is not what was recorded; the "
        "tenant overlay replaces the fingerprint wholesale for exactly this reason.",
        "<b>Repair loop (design):</b> degraded capabilities get a canary "
        "re-validation; a bounded, policy-checked LLM pass may propose a locator "
        "patch as a diff for human review (the brief's assisted-fallback stretch) - "
        "the model proposes, a person approves, replay stays deterministic.",
    ]))
    return story


# -------------------------------------------------------------------------- 11
def sec11():
    story = [cpb(220), H1("11. The mock target application (\"CU BackOffice\")")]
    story.append(serves("Enables the robustness, safety, and escalation demonstrations; stands in for the real"
                        " environment per brief Section 4."))
    story.append(P(
        "A small Express + EJS server-rendered app with deliberately hostile, "
        "legacy-style markup: nested table layouts, no test IDs, generated-looking "
        "IDs (#ctl00_MbrSrch_txtNum), font-tag styling, sparse label associations, "
        "and inline styles. Synthetic data only, held in memory - a successful "
        "sub-account open really mutates it (appends the account, increments the "
        "confirmation counter); restarting resets the seed. It runs offline; "
        "reviewers never need external services (an LLM key is needed only for "
        "discovery). The same server also ships the tenant-B skin: npm run "
        "target:north serves \"CU North TellerWorks\" on port 4650 with green "
        "branding, tw_* ids, and customer vocabulary (Section 10.2)."))
    story.append(H2("11.1 Flows"))
    story.extend(bull([
        "<b>Login</b> - teller credentials (synthetic), session cookie; expiring "
        "the session mid-flow is an injectable fault.",
        "<b>Member search</b> - by member number; not-found is a natural state "
        "(\"No records found.\").",
        "<b>Member detail</b> - name, standing, member-since, and balances inside "
        "nested tables; member 66666 is teller-restricted and renders an "
        "access-denied screen - a natural state, no injection needed.",
        "<b>Open sub-account</b> - multi-field form; deposits under $5.00 are "
        "rejected with a validation message (the DEPOSIT_BELOW_MINIMUM outcome); "
        "the mutating confirm issues a confirmation number - the risky-action demo.",
    ]))
    story.append(H2("11.2 Fault-injection matrix (armed one-shot via GET /__faults?arm=...)"))
    story.append(P(
        "The replay CLI's --inject flag arms exactly one fault before the run; each "
        "fault clears itself the moment it fires, so a recovery's retry sees the "
        "healthy app again - which is what makes bounded recovery meaningful rather "
        "than a tight loop against a permanently broken page."))
    story.append(tbl(
        ["Injection", "App behavior", "Exercises", "System response (as demonstrated)"],
        [
            ["(no injection) unknown member id", "Empty result grid + \"No records "
             "found.\"", "Business outcome", "MEMBER_NOT_FOUND returned as a value"],
            ["(no injection) deposit under $5.00", "Form re-renders with a "
             "validation message", "Business outcome",
             "DEPOSIT_BELOW_MINIMUM, terminal - carried inside the escalated "
             "wrapper when the run also had an approval"],
            ["(no injection) restricted member 66666", "Access-denied screen",
             "Business outcome", "ACCESS_DENIED, terminal"],
            ["interstitial", "Maintenance modal covers the page",
             "Recoverable", "Declared dismiss recovery clicks OK; step retried; "
             "recovery_applied logged"],
            ["slow", "\"Loading, please wait\" placeholder page",
             "Recoverable", "Declared waitRetry recovery: 2500 ms backoff, max 3 "
             "attempts, inside step budgets"],
            ["session-expiry", "Session cookie invalidated on the next request",
             "Recoverable -> escalate", "A declared runSteps re-login can absorb "
             "it; the committed lookup leaves it undeclared, so the checkpoint "
             "fails -> intervention -> human re-authenticates in the live browser "
             "-> completed_step -> resume"],
            ["error500", "Server error page (one-shot)",
             "Hard failure", "Evidence bundle captured; structured hard_failure "
             "returned"],
        ],
        [86, 118, 74, CONTENT_W - 86 - 118 - 74]))
    story.append(sp(4))
    story.append(P(
        "Three capabilities are recorded against the app and committed: "
        "<b>member-savings-lookup</b> (read-only; the real-LLM discovery run), "
        "<b>member-standing-check</b> (two typed outputs; one artifact yields three "
        "terminal shapes - success, ACCESS_DENIED, MEMBER_NOT_FOUND), and "
        "<b>subaccount-open</b> (riskLevel mutating: every replay pauses at the "
        "confirm submit for a signed approval, and a too-small deposit surfaces "
        "DEPOSIT_BELOW_MINIMUM through the same escalated wrapper). The tenant-B "
        "skin is not a stretch note: it is built, served by npm run target:north, "
        "and exercised by the committed cross-tenant replay of Section 10.2."))
    return story


# -------------------------------------------------------------------------- 12
def sec12():
    story = [cpb(220), H1("12. Testing strategy - where it counts")]
    story.append(serves("Code quality (criterion 7): \"tested where it counts\", not blanket coverage."))
    story.append(tbl(
        ["Layer", "What is tested and why it is the right thing"],
        [
            ["Unit: artifact schema + conditions (core.test.ts)", "Zod round-trips, "
             "rejection of malformed artifacts, {{...}} template rendering, "
             "condition-AST evaluation - the contract everything else trusts."],
            ["Unit: policy + redaction (policy.test.ts)", "Allow/deny matrix over "
             "origins, action kinds, risky gates and approval states; the redactor: "
             "registered secrets and their URL-encoded variants never survive into "
             "log output - the safety claims, verified."],
            ["Unit: deviation classifier (classifier.test.ts)", "Precedence (outcome "
             "beats recovery beats failure), bounded retries, fail-closed on unknown "
             "states - the taxonomy the rubric weighs."],
            ["Unit: recorder (recorder.test.ts)", "Literal values -> {{inputs.x}} "
             "parameterization, secret canonicalization, artifact distillation from "
             "the recorded action log."],
            ["Unit: escalation + signing (escalation.test.ts, signing.test.ts)",
             "Intervention lifecycle (pending -> claimed -> resolved; TTL expiry "
             "only fires while still pending), disposition rules, HMAC payload "
             "binding, and verifyResolutionForRecord tamper checks."],
            ["Unit: tenant merge (tenant.test.ts)", "Exact-match vocabulary, "
             "mechanics never rewritten, wholesale step overrides, appId-mismatch "
             "refusal, re-validation of the merged artifact."],
            ["Unit: locator health (locator-health.test.ts)", "Drift aggregation "
             "over telemetry: rank histograms and the drifting/broken classification "
             "behind npm run health --ci."],
            ["Integration: 6 suites (vitest + Playwright against live app "
             "instances)", "replay.test.ts covers the Section 11.2 taxonomy rows "
             "end-to-end; driver.test.ts covers ranked resolution, ambiguity "
             "fail-closed, and the act() chokepoint; escalation.test.ts walks pause "
             "-> claim -> signed disposition -> resume with a scripted operator; "
             "discovery.test.ts drives the real loop with a scripted provider "
             "double; backstop.test.ts proves the network layer kills exfiltration "
             "and redirect chains in-flight; tenant.test.ts proves the overlay and "
             "the fail-closed default."],
        ],
        [118, CONTENT_W - 118], bold_first_col=True))
    story.append(sp(3))
    story.append(P(
        "93 tests across these 14 files, all green. npm test needs no API key and no "
        "pre-started services: integration suites boot their own target-app "
        "instances. Three gates run in order: npm run typecheck (strict TS), npm run "
        "lint (ESLint plus scripts/depcheck.mjs, which fails the build if replay/ "
        "ever imports llm/ - Section 6's determinism enforced structurally), npm "
        "test."))
    story.append(P(
        "Deliberately untested: EJS templates, CLI argument parsing, console styling "
        "- low-risk glue. The live-model path is the one real discovery run committed "
        "as evidence (OpenAI gpt-4o, 9 turns, evidence/disc_20260912173144)."))
    return story


# -------------------------------------------------------------------------- 13
REPO_TREE = r"""
/                            # public GitHub repo root
  README.md                  # setup, keys, demo path (exact commands)
  REPORT.md                  # the 7 required headings
  policy.yaml                # global allowlist and budgets (Appendix C)
  .env.example               # LLM key (discovery only) + demo secrets
  capabilities/              # the three committed artifacts (reviewable JSON)
  tenants/cu-north.json      # tenant-B binding overlay (Section 10.2)
  evidence/                  # 18 committed runs: disc_*, replay_* (Section 9)
  docs/                      # this document (and its generator)
  scripts/                   # auto-approve.ts, capture-escalation.ts,
                             #   depcheck.mjs (the import-boundary gate)
  src/
    core/  surface/  llm/  agent/  replay/
    policy/  escalation/  evidence/  cli/
    target-app/              # mock CU back-office, both tenant skins
  test/
    fixtures/  unit/  integration/
"""

DEMO_CMDS = r"""
npm install && npx playwright install chromium
npm run target                     # mock app on http://localhost:4600

# 1. DISCOVERY (uses an LLM key once): goal in, capability artifact out
npm run discover -- \
  --goal "Look up the member by member number and read their savings account balance" \
  --entry http://localhost:4600/login \
  --id member-savings-lookup --name "Member savings balance lookup" \
  --app cu-backoffice --input memberId=12345 --provider openai
# -> capabilities/member-savings-lookup.json (reviewStatus: draft)

# 2. Review + approve (gates unattended replay of risky capabilities)
npm run approve -- --capability member-savings-lookup --reviewer you

# 3. DETERMINISTIC REPLAY (no LLM key): typed params in, typed outputs out
npm run replay -- --capability member-savings-lookup --param memberId=12345
#   -> success { savingsBalance: "$1,204.55" }  + locator-rank telemetry
npm run replay -- --capability member-savings-lookup --param memberId=99999
#   -> business_outcome MEMBER_NOT_FOUND (a declared answer, not an error)
npm run replay -- --capability member-savings-lookup --param memberId=12345 \
  --inject interstitial            # -> declared recovery dismisses the dialog

# 4. ESCALATION: one-shot session expiry -> checkpoint fails -> intervention
npm run replay -- --capability member-savings-lookup --param memberId=12345 \
  --inject session-expiry --headed
#   open the tokened console URL the CLI prints: claim -> re-authenticate in
#   the headed browser (same live session) -> resolve "completed_step"
#   -> engine re-verifies the checkpoint and resumes -> escalated / success

# 5. Multi-tenant: the same artifact on re-skinned tenant B (Section 10.2)
npm run target:north               # tenant B on http://localhost:4650
npm run replay -- --capability member-savings-lookup --tenant cu-north \
  --param memberId=12345           # -> success, every step at rank 0

npm run catalog                    # capabilities as an agent-facing summary
npm run health                     # locator-health drift report (--ci gate)
"""


def sec13():
    story = [H1("13. Repository layout and deliverables mapping")]
    story.append(serves("Communication (criterion 8) and the brief's exact deliverable paths."))
    story.extend(code(REPO_TREE, chunk=44))
    story.append(P(
        "REPORT.md uses the seven mandated headings verbatim - Architecture, Artifact "
        "schema, Determinism and error handling, Heterogeneity and multi-tenant, "
        "Escalation and handoff, Safety, Cuts - each a distilled page-share of this "
        "document's Sections 3, 5, 6, 10, 7, 8, and 14 respectively. Replay runs with "
        "no API key; only discovery needs one, and README says so up front."))
    story.append(H2("13.1 Demo path (condensed from README)"))
    story.extend(code(DEMO_CMDS, chunk=44))
    story.append(P(
        "The README additionally walks the mutating subaccount-open demo (pause at "
        "the risky submit -> approve_once -> confirmation number; a $2.00 deposit "
        "surfaces DEPOSIT_BELOW_MINIMUM instead), the member-standing-check drift "
        "demo, and two scripted operators (scripts/capture-escalation.ts, "
        "scripts/auto-approve.ts) that drive the same console HTTP API a human "
        "would - the identical control-transfer path, no human required."))
    return story


# -------------------------------------------------------------------------- 14
def sec14():
    story = [PageBreak(), H1("14. Implementation roadmap as executed, cut lines, and stretch goals")]
    story.append(serves("Everything - this is the order in which the criteria were built and verified."))
    story.append(H2("14.1 Phases (as planned - and as executed; est. 28-36 focused hours)"))
    story.append(tbl(
        ["Ph", "Build", "Exit criterion (definition of done)", "Hrs"],
        [
            ["0", "Scaffold: strict TS, ESLint + dependency-boundary rule, vitest, "
             "prettier", "CI-green empty skeleton; replay/ -> llm/ import fails lint",
             "1-2"],
            ["1", "core/: artifact schema, condition AST, result contract, policy "
             "config (Zod)", "Appendix A artifact parses; malformed fixtures rejected;"
             " types inferred", "3-4"],
            ["2", "target-app/: flows, legacy markup, fault injection, seed data",
             "All Section 11.2 states reachable by hand in a browser", "3-4"],
            ["3", "surface/: PlaywrightDriver - a11y observe, ranked resolve, act "
             "with policy chokepoint, screenshots",
             "Driver test suite green incl. frames and ambiguity fail-closed",
             "4-5"],
            ["4", "policy/ + evidence/: engine, redacting JSONL logger, run dirs",
             "Policy matrix tests green; secret-scan test proves no leaks", "2-3"],
            ["5", "llm/ + agent/: both providers, discovery loop, stop conditions, "
             "Recorder with parameterization + probe runs",
             "Real discovery completes the lookup goal; artifact emitted and valid",
             "5-6"],
            ["6", "replay/: executor, waits, checkpoints, classifier, recoveries, "
             "result contract",
             "All taxonomy integration tests green; no-API-key replay verified",
             "5-6"],
            ["7", "escalation/: RunController, intervention store, operator console, "
             "human-action recorder, resume",
             "session-expiry scenario: pause -> human login in same browser -> "
             "resume -> success, fully evidenced", "4-5"],
            ["8", "cli/ + evidence capture: the committed evidence set (18 runs); "
             "README demo path verified from a clean clone",
             "A reviewer can reproduce replay demos with three commands", "2-3"],
            ["9", "REPORT.md (7 headings), README polish, final read-through",
             "Docs match behavior; cut lines explicit", "2-3"],
        ],
        [18, 168, CONTENT_W - 18 - 168 - 26, 26]))
    story.append(sp(4))
    story.append(P(
        "All ten exit criteria hold in the committed repo (93/93 tests, the evidence "
        "set, no-key replay). The one piece of work the plan did not anticipate: the "
        "<b>network-layer backstop</b> (Section 8.5), added when implementation "
        "demonstrated that the act() chokepoint alone cannot govern traffic the page "
        "initiates by itself - the committed redirect-chain tests are the record of "
        "that reversal."))
    story.append(H2("14.2 Cut lines - deliberate, with the seam designed"))
    story.extend(bull([
        "<b>Operator console is minimal by intent</b> (list, claim, resolve - "
        "token-authenticated, dispositions HMAC-signed): the brief scopes out a real "
        "co-browsing console; the control-transfer model is the graded part and it "
        "is fully real.",
        "<b>Remote session streaming (CDP screencast / noVNC):</b> designed in "
        "Section 7.4, not built - the local headed browser makes the handoff real "
        "without transport work.",
        "<b>Desktop and vision drivers:</b> interface + design only (Section 10.1); "
        "the brief says design, not build.",
        "<b>Assisted LLM recovery on replay failure:</b> designed as a "
        "propose-a-patch flow (Section 10.3), not built - keeps the replay path "
        "pure.",
        "<b>Shared-secret HMAC and a single operator identity</b> instead of "
        "per-operator OIDC + KMS-held asymmetric keys: scope cut documented in "
        "Section 7.6 with the production path named.",
    ]))
    story.append(H2("14.3 Stretch goals - both attempted, both landed"))
    story.extend(bull([
        "<b>1. Agent-facing capability catalog (built):</b> npm run catalog lists "
        "the committed artifacts as agent-facing contract summaries - the contract "
        "band of Section 5 (typed inputs/outputs, outcomes, risk and review state) "
        "without the mechanics - closing the brief's through-line: the artifact as "
        "an agent-invocable capability.",
        "<b>2. Tenant-B variant (built):</b> the CU North TellerWorks skin plus "
        "tenants/cu-north.json replay the tenant-A-recorded artifact unchanged on "
        "tenant B (committed run replay_20260913151918) - Section 10 is a "
        "demonstration, not a promise.",
    ]))
    story.append(H2("14.4 What gets built next with more time"))
    story.extend(bull([
        "Prevention-grade redirect interception via CDP Fetch.requestPaused, "
        "upgrading the Section 8.5 watchdog's detect-and-kill residual to true "
        "prevention.",
        "Operator identity and keys: per-operator OIDC on the console; asymmetric, "
        "KMS-held signing keys replacing the shared HMAC secret (Section 7.6).",
        "A stability harness (on the order of 50 replays per capability per app "
        "version) plus canary re-validation feeding the locator-health report, and "
        "confidence scoring gating unattended runs.",
        "The assisted-fallback repair loop: bounded LLM-proposed locator patches, "
        "shipped as reviewed diffs (Section 10.3).",
        "A signed capability registry: approval workflow, distribution, revocation.",
        "DLP-style scanning of extracted outputs, beyond declared-sensitive masking.",
        "Desktop (UIA/AX) and vision drivers behind the same SurfaceDriver seam; "
        "remote operator transport (CDP screencast / noVNC).",
        "OpenTelemetry export of the run/step telemetry that today lands in "
        "result.json.",
    ]))
    return story


# -------------------------------------------------------------------------- 15
def sec15():
    story = [cpb(240), H1("15. Risk register")]
    story.append(tbl(
        ["Risk", "L", "I", "Mitigation / outcome"],
        [
            ["Discovery flakiness (model meanders, mislabels targets)", "M", "M",
             "Closed four-tool action set, compact numbered snapshots, loop "
             "detector, declare_outcome grounded against on-screen text; only a "
             "verified successful run is distilled, and retry runs are cheap. The "
             "committed recording took one 9-turn run."],
            ["Hostile markup yields poor accessible names", "M", "M",
             "nearText/bbox ranks exist for exactly this; the mock app keeps "
             "visible text anchors (as real back-office apps do). Observed in "
             "practice: the standing-check drift lands on the parameterized "
             "nearText rank - degraded, not broken."],
            ["Page-initiated traffic bypasses the act() chokepoint (exfil "
             "subresources, redirect chains)", "H", "H",
             "Materialized during implementation and addressed: the network "
             "backstop (Section 8.5) aborts off-allowlist requests, vets first-hop "
             "redirects, and a watchdog kills the context on later hops. Residual: "
             "a later hop's egress races the kill - detection is guaranteed; "
             "prevention is the CDP upgrade (14.4)."],
            ["Human-action recording rabbit hole", "M", "L",
             "Scope pinned to clicks/inputs/submits/navigations via one injected "
             "binding (startHumanCapture), password values masked at the source; "
             "anything deeper is out of scope and documented."],
            ["Handoff race conditions (agent acts while human drives)", "L", "H",
             "Control ownership is a single in-process ledger with legal-transition "
             "checks and a hash-chained audit trail; the executor blocks while "
             "HUMAN holds control, and every transition is a logged "
             "control_transition event carrying the chain hash."],
            ["Sensitive data slips into evidence", "L", "H",
             "Redaction at the logger boundary (single write path, URL-encoded "
             "variants included), secret-scan tests, parameterized artifacts; the "
             "committed result.json files show the masked savingsBalance."],
            ["Scope creep vs the time box", "M", "M",
             "Phase exit criteria; cut lines pre-declared; stretch goals gated on a "
             "finished core - and landed only after the suite was green."],
        ],
        [168, 18, 18, CONTENT_W - 168 - 36]))
    story.append(sp(3))
    story.append(P("L = likelihood, I = impact (H/M/L)."))
    story.append(PageBreak())
    return story


# ------------------------------------------------------------------ appendices
ARTIFACT_FULL = r"""
{
  "schemaVersion": "1.0",
  "capability": {
    "id": "member-savings-lookup",
    "version": "1.0.0",
    "name": "Member savings balance lookup",
    "description": "Look up the member by member number and read their savings account balance"
  },
  "target": {
    "appId": "cu-backoffice",
    "surface": "web",
    "entrypoint": "{{env.APP_BASE_URL}}/login",
    "appFingerprint": { "titlePattern": "CU BackOffice -", "markers": [] }
  },
  "inputs": [
    { "name": "memberId", "type": "string", "required": true, "pattern": "^\\d+$",
      "sensitive": false, "example": "12345" }
  ],
  "outputs": [
    { "name": "savingsBalance", "type": "money", "sensitive": true, "sourceStep": "s9" }
  ],
  "steps": [
    { "id": "s1", "intent": "Open the application entrypoint", "action": "navigate",
      "url": "{{env.APP_BASE_URL}}/login", "sensitive": false,
      "checkpoint": { "urlMatches": "/login" }, "risk": "safe" },
    { "id": "s2", "intent": "Enter teller username", "action": "fill",
      "target": {
        "strategies": [
          { "kind": "role", "role": "textbox", "name": "Teller ID" },
          { "kind": "labelText", "value": "Teller ID" },
          { "kind": "nearText", "value": "Teller ID" },
          { "kind": "css", "value": "#ctl00_LoginCtl_txtUser" },
          { "kind": "bbox", "value": [603, 135, 139, 21] }
        ],
        "elementDescription": "textbox \"Teller ID\"", "framePath": []
      },
      "value": "{{secrets.tellerUsername}}", "sensitive": true, "risk": "safe" },
    { "id": "s3", "intent": "Enter teller password", "action": "fill",
      "target": {
        "strategies": [
          { "kind": "role", "role": "textbox", "name": "Passcode" },
          { "kind": "labelText", "value": "Passcode" },
          { "kind": "nearText", "value": "Passcode" },
          { "kind": "css", "value": "#ctl00_LoginCtl_txtPass" },
          { "kind": "bbox", "value": [603, 168, 139, 21] }
        ],
        "elementDescription": "textbox \"Passcode\"", "framePath": []
      },
      "value": "{{secrets.tellerPassword}}", "sensitive": true, "risk": "safe" },
    { "id": "s4", "intent": "Sign in to teller system", "action": "click",
      "target": {
        "strategies": [
          { "kind": "role", "role": "button", "name": "Sign In" },
          { "kind": "css", "value": "#ctl00_LoginCtl_btnGo" },
          { "kind": "bbox", "value": [603, 201, 58, 21] }
        ],
        "elementDescription": "button \"Sign In\"", "framePath": []
      },
      "sensitive": false, "checkpoint": { "urlMatches": "/desk" }, "risk": "safe" },
    { "id": "s5", "intent": "Navigate to member search", "action": "click",
      "target": {
        "strategies": [
          { "kind": "role", "role": "link", "name": "Member Search" },
          { "kind": "css", "value": "#ctl00_Nav_lnkSearch" },
          { "kind": "bbox", "value": [84, 34, 89, 16] }
        ],
        "elementDescription": "link \"Member Search\"", "framePath": []
      },
      "sensitive": false, "checkpoint": { "urlMatches": "/members" }, "risk": "safe" },
    { "id": "s6", "intent": "Input member number for search", "action": "fill",
      "target": {
        "strategies": [
          { "kind": "nearText", "value": "Member Number" },
          { "kind": "css", "value": "#ctl00_MbrSrch_txtNum" },
          { "kind": "bbox", "value": [128, 106, 97, 21] }
        ],
        "elementDescription": "textbox near \"Member Number\"", "framePath": []
      },
      "value": "{{inputs.memberId}}", "sensitive": false, "risk": "safe" },
    { "id": "s7", "intent": "Perform member search", "action": "click",
      "target": {
        "strategies": [
          { "kind": "role", "role": "button", "name": "Search" },
          { "kind": "nearText", "value": "Member Number" },
          { "kind": "css", "value": "#ctl00_MbrSrch_btnFind" },
          { "kind": "bbox", "value": [237, 106, 58, 21] }
        ],
        "elementDescription": "button \"Search\"", "framePath": []
      },
      "sensitive": false, "risk": "safe" },
    { "id": "s8", "intent": "Access member details for Alvarez, Maria", "action": "click",
      "target": {
        "strategies": [
          { "kind": "role", "role": "link", "name": "Alvarez, Maria" },
          { "kind": "nearText", "value": "{{inputs.memberId}}" },
          { "kind": "css", "value": "#ctl00_MbrGrd_r0_c1 > font > a" },
          { "kind": "bbox", "value": [274, 201, 80, 16] }
        ],
        "elementDescription": "link \"Alvarez, Maria\"", "framePath": []
      },
      "sensitive": false,
      "checkpoint": { "urlMatches": "/members/{{inputs.memberId}}" }, "risk": "safe" },
    { "id": "s9", "intent": "Record the savings account balance of the member",
      "action": "extract",
      "target": {
        "strategies": [
          { "kind": "nearText", "value": "Savings" },
          { "kind": "css", "value": "#ctl00_AcctGrd_r0_c2 > font" },
          { "kind": "bbox", "value": [640, 302, 57, 16] }
        ],
        "elementDescription": "font near \"Savings\"", "framePath": []
      },
      "sensitive": false, "outputName": "savingsBalance",
      "extractPattern": "\\$[\\d,]+\\.\\d{2}", "risk": "safe" }
  ],
  "outcomes": [
    { "code": "MEMBER_NOT_FOUND", "terminal": true,
      "description": "The member with ID 99999 could not be found in the system.",
      "detector": { "textPresent": "No records found." } }
  ],
  "recoveries": [
    { "id": "maintenance-interstitial", "appliesTo": "global",
      "detector": { "elementVisible": { "kind": "role", "role": "dialog", "name": "System Notice" } },
      "action": { "kind": "dismiss", "target": {
        "strategies": [
          { "kind": "role", "role": "button", "name": "OK" },
          { "kind": "css", "value": "#ctl00_Notice_btnOk" }
        ],
        "elementDescription": "OK button on the maintenance notice dialog", "framePath": []
      } },
      "maxAttempts": 2 },
    { "id": "transient-slow-load", "appliesTo": "global",
      "detector": { "textPresent": "Loading, please wait" },
      "action": { "kind": "waitRetry", "backoffMs": 2500 }, "maxAttempts": 3 }
  ],
  "successCheckpoint": { "urlMatches": "/members/{{inputs.memberId}}" },
  "policy": {
    "requiredOrigins": ["http://localhost:4600"],
    "allowedActionKinds": ["navigate", "fill", "click", "extract"],
    "riskLevel": "readonly",
    "unattendedReplay": true
  },
  "provenance": {
    "provider": "openai",
    "model": "gpt-4o",
    "runId": "disc_20260912173144",
    "recordedAt": "2026-09-12T17:31:59.793Z",
    "reviewStatus": "approved",
    "reviewedBy": "operator-jsmith",
    "reviewedAt": "2026-09-12T17:36:57.490Z"
  }
}
"""

RESULTS_JSON = r"""
// evidence/replay_20260912173725/result.json - SUCCESS (telemetry trimmed)
{
  "runId": "replay_20260912173725",
  "mode": "replay",
  "capabilityId": "member-savings-lookup",
  "capabilityVersion": "1.0.0",
  "params": { "memberId": "12345" },
  "startedAt": "2026-09-12T17:37:25.176Z",
  "finishedAt": "2026-09-12T17:37:26.601Z",
  "result": {
    "status": "success",
    "outputs": { "savingsBalance": "***" }    // sensitive -> masked before disk;
  },                                          //   the live terminal prints the value
  "telemetry": [
    { "stepId": "s1", "strategyRank": null, "attempts": 1,
      "recoveriesApplied": [], "durationMs": 95 },        // navigate: untargeted
    { "stepId": "s2", "strategyRank": 0, "strategyKind": "role", "attempts": 1,
      "recoveriesApplied": [], "durationMs": 89 }
    // ... s3-s9 identical shape; every step resolved at rank 0 (role/nearText)
  ],
  "evidenceDir": "evidence/replay_20260912173725"
}

// evidence/replay_20260912173732/result.json - BUSINESS OUTCOME (result block;
// its telemetry ends at s7, where the detector legitimately stopped the run)
"result": {
  "status": "business_outcome",
  "code": "MEMBER_NOT_FOUND",
  "description": "The member with ID 99999 could not be found in the system.",
  "extracted": {}
}

// evidence/replay_20260913015057/result.json - ESCALATED risky run (excerpt)
"params": { "memberId": "12345", "accountType": "Checking",
            "nickname": "Rainy Day", "depositAmount": "40.00" },
"result": {
  "status": "escalated",
  "interventions": [
    { "id": "iv_replay_20260913015057_1",
      "reason": "capability policy forbids unattended risky actions",
      "type": "approval",
      "disposition": "approve_once",
      "operator": "operator-jsmith" }
  ],
  "finalStatus": "success",                 // the wrapped underlying result
  "outputs": { "confirmationNumber": "CU-2026-4182" }
}

// HARD FAILURE - the remaining arm of the union. No committed demo run ends
// this way (recoveries or escalation absorb the injected faults); the shape
// from src/core/result.ts, illustrative values:
{
  "status": "hard_failure",
  "error": {
    "stepId": "s7",
    "intent": "Perform member search",
    "expected": "urlMatches(/members)",
    "observed": "checkpoint not satisfied after 3 attempts",
    "evidence": ["evidence/replay_x/screenshots/007_failure.png"]
  }
}
"""

POLICY_YAML = r"""
# policy.yaml as committed (comments re-wrapped to fit the page).
# Global allowlist and budgets. Deny by default: anything not listed here is
# refused at the SurfaceDriver chokepoint, regardless of what the model asks.
allowlist:
  origins:
    - http://localhost:4600   # mock CU back-office - tenant A (Community One)
    - http://localhost:4650   # same product re-skinned - tenant B
                              #   (CU North, via tenants/cu-north.json)

actionKinds: [navigate, click, fill, select, press, extract]

risky:
  discoveryRequiresConfirmation: true        # a human approves every mutating
                                             #   action while recording
  unattendedRequiresApprovedArtifact: true   # replay may auto-run risky steps
                                             #   only for reviewed artifacts

budgets:
  discoveryMaxTurns: 40
  stepTimeoutMs: 15000
  runTimeoutMs: 300000
  maxStepAttempts: 3

escalation:
  operatorPort: 4700
  interventionTtlMinutes: 30

redaction:
  maskReplacement: "***"
  extraSecretEnvPrefixes: ["SCRIBE_SECRET_"]
"""


def appendices():
    story = [H1("Appendix A - The committed artifact (capabilities/member-savings-lookup.json)")]
    story.append(P(
        "Recorded by the real gpt-4o discovery run, approved via npm run approve, "
        "and executed by the committed replay evidence - content verbatim, JSON "
        "whitespace compacted to fit the page (the file pretty-prints each strategy "
        "across multiple lines). Internally consistent with Sections 5, 6, and 11 "
        "because it is not an example: it is the artifact."))
    story.extend(code(ARTIFACT_FULL, small=True, chunk=52))
    story.append(PageBreak())
    story.append(H1("Appendix B - Result contract examples (committed runs)"))
    story.append(P(
        "Real committed result.json files, trimmed where marked. The success run "
        "shows savingsBalance as \"***\" because the output is declared sensitive "
        "and redaction happens before anything reaches disk; the live terminal "
        "prints the real value."))
    story.extend(code(RESULTS_JSON, chunk=44))
    story.append(sp(6))
    story.append(H1("Appendix C - policy.yaml"))
    story.extend(code(POLICY_YAML, chunk=44))
    return story
