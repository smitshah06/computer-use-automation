"""Sections 10-15 and appendices."""
from reportlab.platypus import PageBreak

from style import (
    CONTENT_W, H1, H2, P, bull, callout, code, cpb, serves, sp, tbl,
)

# -------------------------------------------------------------------------- 10
DRIVER_IFACE = r"""
interface SurfaceDriver {
  open(entrypoint: string): Promise<void>;
  observe(): Promise<UiSnapshot>;            // { url?, title?, nodes: UiNode[] }
  resolve(t: TargetDescriptor): Promise<Resolved | Ambiguous | NotFound>;
  act(a: StepAction, h?: NodeHandle): Promise<ActResult>;   // policy checked inside
  screenshot(mask?: TargetDescriptor[]): Promise<Buffer>;
  capabilities(): { hasA11yTree: boolean; hasDomFallback: boolean;
                    coordinateActions: boolean };
}

interface UiNode {                            // the surface-agnostic observation unit
  ref: string;  role: string;  name?: string;  value?: string;
  states: string[];  bbox: [x: number, y: number, w: number, h: number];
  framePath: string[];                        // window/frame/pane addressing
}
"""

TENANT_BINDING = r"""
{
  "tenantId": "cu-eastshore",
  "appId": "vendorcore-teller", "appVersion": "9.4.x",
  "binding": {
    "entrypoint": "https://teller.eastshore.example/login",
    "secretsRef": "vault://eastshore/teller-bot",
    "vocabulary": { "Member": "Customer" },        // applied to name/label/text strategies
    "locatorOverrides": [
      { "stepId": "s3", "prepend": { "kind": "css", "value": "#custNum" } }
    ],
    "flags": { "hasMaintenanceInterstitial": true }
  }
}
"""


def sec10():
    story = [H1("10. Heterogeneity and multi-tenant reuse (design)")]
    story.append(serves("Generalization to the real environment (criterion 5). Design-only by the brief's"
                        " instruction; the seams are built, the extra drivers are not."))
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
            ["Legacy web (designed; the mock app approximates it)", "Same driver - "
             "resolution simply lands lower in the strategy ranking (nearText, "
             "relativeTo, css, bbox) because roles/labels are sparse. framePath "
             "addresses framesets. No schema change.",],
            ["Desktop (designed)", "UIA (Windows) / AXUIElement (macOS) driver: the "
             "OS accessibility tree maps onto the same UiNode shape - the glossary "
             "itself notes a11y trees exist on desktop. role+name strategies carry "
             "over; css ranks are skipped via capabilities()."],
            ["Screenshot-only / hostile (designed)", "Vision driver: observe via "
             "OCR + detection into UiNode[]; resolve uses elementDescription + "
             "bboxHint (recorded for exactly this); act by coordinates. A model "
             "assists <b>perception only</b> - decisions stay deterministic, and the "
             "policy chokepoint is unchanged."],
        ],
        [128, CONTENT_W - 128], bold_first_col=True))
    story.append(sp(4))
    story.append(H2("10.2 Multi-tenant reuse: base artifact + tenant binding overlay"))
    story.append(P(
        "Hundreds of institutions run the same vendor product, differently branded and "
        "versioned. Re-recording per tenant is the failure mode to avoid, so the unit "
        "of recording is the <b>vendor product</b> (base artifact), and each tenant "
        "contributes only a thin, reviewable <b>binding</b>:"))
    story.extend(code(TENANT_BINDING, chunk=44))
    story.extend(bull([
        "<b>Merge at load:</b> replay resolves base + binding into an effective "
        "artifact; overrides are per-step patches (prepend/replace a strategy), the "
        "vocabulary map rewrites name/label/text strategy values, and the base is "
        "never mutated - one upgrade path, many tenants.",
        "<b>Why semantic-first locators make this work:</b> role/label/nearText "
        "survive branding and theming; only the brittle css rank routinely needs a "
        "tenant patch - which is precisely where the override slot sits.",
        "<b>Safe specialization:</b> bindings carry no flow logic - a tenant cannot "
        "accidentally fork behavior, only identification and configuration. A tenant "
        "needing a different flow is a new capability version, reviewed like any "
        "other.",
    ]))
    story.append(H2("10.3 Detecting and managing drift"))
    story.extend(bull([
        "<b>Telemetry as sensor:</b> every replay records, per step, which strategy "
        "rank matched (fallbackDepth), attempts, and timings. Aggregated per "
        "tenant/app-version, rising fallback depth or a new failure signature is the "
        "early-warning \"locator health\" signal - drift is observed from production "
        "replays, not discovered by outages.",
        "<b>Fail fast on version drift:</b> appFingerprint mismatch at preflight "
        "stops the run with DRIFT_SUSPECTED before any action - never act on an app "
        "that is not what was recorded.",
        "<b>Repair loop (design):</b> degraded capabilities get a canary "
        "re-validation; a bounded, policy-checked LLM pass may propose a locator "
        "patch as a diff for human review (the brief's assisted-fallback stretch) - "
        "the model proposes, a person approves, replay stays deterministic.",
    ]))
    story.append(PageBreak())
    return story


# -------------------------------------------------------------------------- 11
def sec11():
    story = [H1("11. The mock target application (\"CU BackOffice\")")]
    story.append(serves("Enables the robustness, safety, and escalation demonstrations; stands in for the real"
                        " environment per brief Section 4."))
    story.append(P(
        "A small Express + EJS server-rendered app with deliberately hostile, "
        "legacy-style markup: nested table layouts, no test IDs, generated-looking "
        "IDs (ctl00_pnlSrch_txtMbr), sparse label associations, inline styles, and a "
        "frameset-style shell on the detail screen. Synthetic data only. It runs "
        "offline; reviewers never need external services (the LLM key is needed only "
        "for discovery)."))
    story.append(H2("11.1 Flows"))
    story.extend(bull([
        "<b>Login</b> - teller credentials (synthetic), session cookie with expiry.",
        "<b>Member search</b> - by member number; not-found is a natural state.",
        "<b>Member detail</b> - balances table (savings, checking) inside nested "
        "tables/frames; permission-restricted member 40001 renders an access-denied "
        "screen.",
        "<b>Open sub-account</b> - multi-field form, validation errors, review "
        "screen, then a mutating confirm that issues a confirmation number - the "
        "risky-action demo.",
    ]))
    story.append(H2("11.2 Fault-injection matrix (query flag or config)"))
    story.append(tbl(
        ["Injection", "App behavior", "Exercises", "Expected system response"],
        [
            ["(none) bad member id", "Empty result + \"No records found\"",
             "Business outcome", "MEMBER_NOT_FOUND returned as a value"],
            ["validation", "Form rejects with field messages",
             "Business outcome", "VALIDATION_REJECTED + extracted messages"],
            ["denied (member 40001)", "Access-denied screen",
             "Business outcome", "PERMISSION_DENIED, terminal"],
            ["interstitial", "Maintenance modal before content",
             "Recoverable", "Declared recovery dismisses; step retried; logged"],
            ["slow", "3-8s delayed responses",
             "Recoverable", "Bounded wait/retry within budgets"],
            ["expire", "Session cookie invalidated mid-flow",
             "Recoverable -> escalate", "Re-auth recovery; if disabled by policy, "
             "intervention -> human login -> resume"],
            ["error500", "Server error page",
             "Hard failure", "Evidence bundle; structured hard_failure"],
        ],
        [78, 132, 82, CONTENT_W - 78 - 132 - 82]))
    story.append(sp(4))
    story.append(P(
        "Demo capabilities recorded against it: <b>member-savings-lookup</b> "
        "(read-only; the committed discovery run) and <b>open-sub-account</b> "
        "(contains a risky step; demonstrates the approval gate). A tenant-B skin "
        "(different branding, \"Customer\" vocabulary, one changed control id) is the "
        "cross-tenant stretch demo."))
    return story


# -------------------------------------------------------------------------- 12
def sec12():
    story = [cpb(220), H1("12. Testing strategy - where it counts")]
    story.append(serves("Code quality (criterion 7): \"tested where it counts\", not blanket coverage."))
    story.append(tbl(
        ["Layer", "What is tested and why it is the right thing"],
        [
            ["Unit: artifact schema", "Zod round-trips (parse-serialize-parse), "
             "rejection of malformed artifacts, template rendering incl. escaping - "
             "the contract everything else trusts."],
            ["Unit: policy engine", "Allow/deny matrix over origins, action kinds, "
             "risk gates, approval states - the safety claims, verified."],
            ["Unit: deviation classifier", "Precedence (outcome beats recovery beats "
             "failure), bounded retries, unknown-state fail-closed - the taxonomy "
             "the rubric weighs."],
            ["Unit: locator resolution", "Fixture HTML pages: rank order, uniqueness "
             "rule, fallback-depth telemetry, frame addressing."],
            ["Unit: redaction", "Sensitive params/secrets never appear in log output "
             "or serialized artifacts (asserted by scanning)."],
            ["Integration (vitest + Playwright vs the mock app)", "One test per "
             "taxonomy row of Section 11.2, plus the happy path and an "
             "escalate-and-resume walkthrough with a scripted \"operator\" driving "
             "the console API."],
        ],
        [108, CONTENT_W - 108], bold_first_col=True))
    story.append(sp(3))
    story.append(P(
        "Deliberately untested: EJS templates, CLI arg parsing, console styling - "
        "low-risk glue. The LLM call itself is tested with a recorded-response fake; "
        "the one real discovery run is the live proof, committed as evidence."))
    return story


# -------------------------------------------------------------------------- 13
REPO_TREE = r"""
/                         # public GitHub repo root
  README.md               # setup, keys, demo path (exact commands)
  REPORT.md               # the 7 required headings, 1-3 pages
  policy.yaml             # global allowlist and budgets
  .env.example            # ANTHROPIC_API_KEY / OPENAI_API_KEY (discovery only)
  artifacts/              # saved capabilities (reviewable JSON, versioned names)
  evidence/               # committed runs: disc_*, replay_* (Section 9)
  src/
    core/  surface/  llm/  agent/  replay/
    policy/  escalation/  evidence/  cli/
  src/target-app/         # mock CU back-office (standalone)
  test/                   # unit + integration
"""

DEMO_CMDS = r"""
npm install && npx playwright install chromium
npm run target                       # mock app on http://localhost:4600
npm run operator                     # operator console on http://localhost:4700

npm run discover -- --goal "Look up member 12345 and read their current savings \
  balance" --entry http://localhost:4600 --param memberId=12345 \
  --probe memberId=99999             # discovery + outcome probe -> artifacts/...

npm run replay -- -c member-savings-lookup -p memberId=12345          # success
npm run replay -- -c member-savings-lookup -p memberId=99999          # business outcome
npm run replay -- -c member-savings-lookup -p memberId=12345 --inject interstitial
npm run replay -- -c member-savings-lookup -p memberId=12345 --inject expire
                                     # -> intervention -> take over in the headed
                                     #    browser -> resume from the console
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
    story.append(H2("13.1 Demo path (verbatim in README)"))
    story.extend(code(DEMO_CMDS, chunk=44))
    return story


# -------------------------------------------------------------------------- 14
def sec14():
    story = [PageBreak(), H1("14. Implementation roadmap, cut lines, and stretch goals")]
    story.append(serves("Everything - this is the order in which the criteria get built and verified."))
    story.append(H2("14.1 Phases (est. 28-36 focused hours total)"))
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
             "with policy chokepoint, screenshots+masking",
             "Driver test-page suite green incl. frames and ambiguity fail-closed",
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
             "expire scenario: pause -> human login in same browser -> resume -> "
             "success, fully evidenced", "4-5"],
            ["8", "cli/ + evidence capture: the four committed runs; README demo "
             "path verified from a clean clone",
             "A reviewer can reproduce replay demos with three commands", "2-3"],
            ["9", "REPORT.md (7 headings), README polish, final read-through",
             "Docs match behavior; cut lines explicit", "2-3"],
        ],
        [18, 168, CONTENT_W - 18 - 168 - 26, 26]))
    story.append(sp(4))
    story.append(H2("14.2 Cut lines - deliberate, with the seam designed"))
    story.extend(bull([
        "<b>Operator console is minimal by intent</b> (list, claim, resume, "
        "dispositions): the brief scopes out a real co-browsing console; the "
        "control-transfer model is the graded part and it is fully real.",
        "<b>Remote session streaming (CDP screencast / noVNC):</b> designed in "
        "Section 7.4, not built - local headed browser makes the handoff real "
        "without transport work.",
        "<b>Desktop and vision drivers:</b> interface + design only (Section 10.1); "
        "the brief says design, not build.",
        "<b>Multi-tenant bindings:</b> schema + merge design (Section 10.2); built "
        "only if the stretch demo is attempted.",
        "<b>Assisted LLM recovery on replay failure:</b> designed as a "
        "propose-a-patch flow (10.3), not built - keeps the replay path pure.",
    ]))
    story.append(H2("14.3 Stretch goals - at most two, in this order"))
    story.extend(bull([
        "<b>1. Agent-facing capability catalog:</b> a catalog command / tiny endpoint "
        "listing artifacts as callable tools (name, description, JSON-schema params "
        "derived from inputs) plus one scripted invocation - it closes the brief's "
        "through-line loop (the artifact as an agent-invocable capability) for a few "
        "hours of work.",
        "<b>2. Tenant-B variant:</b> re-skinned mock app + a TenantBinding making the "
        "same base artifact pass on both - turns the Section 10 story into a "
        "demonstration.",
    ]))
    story.append(H2("14.4 What gets built next with more time"))
    story.append(P(
        "Confidence scoring from replay telemetry gating unattended runs; the "
        "assisted-recovery patch proposer; artifact registry with signed approvals; "
        "remote operator transport; a desktop (UIA) driver against a sample WinForms "
        "app; canonicalization of routes into parameterized patterns across "
        "capabilities."))
    return story


# -------------------------------------------------------------------------- 15
def sec15():
    story = [cpb(240), H1("15. Risk register")]
    story.append(tbl(
        ["Risk", "L", "I", "Mitigation"],
        [
            ["Discovery flakiness (model meanders, mislabels targets)", "M", "M",
             "Closed tool set, temperature 0, compact snapshots, loop detector, "
             "probe-run design; only a verified successful run is distilled; retry "
             "runs are cheap by design."],
            ["Hostile markup yields poor accessible names", "M", "M",
             "nearText/relativeTo/bbox ranks exist for exactly this; the mock app "
             "keeps visible text anchors (as real back-office apps do)."],
            ["Human-action recording rabbit hole", "M", "L",
             "Scope pinned to clicks/fills/navigations via one injected binding; "
             "anything deeper is out of scope and documented."],
            ["Handoff race conditions (agent acts while human drives)", "L", "H",
             "Single control token checked in awaitControl() before every step and "
             "asserted inside driver.act(); transitions are atomic in one process."],
            ["Sensitive data slips into evidence", "L", "H",
             "Redaction at the logger boundary (single write path), secret-scan "
             "unit test, screenshot masking, parameterized artifacts."],
            ["Scope creep vs the time box", "M", "M",
             "Phase exit criteria above; cut lines pre-declared; stretch goals "
             "gated on a finished core."],
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
    "name": "Look up member savings balance",
    "description": "Finds a member by member number and returns the current savings
                    balance shown on the member detail screen.",
    "version": "1.0.0",
    "tags": ["read-only", "member-servicing"]
  },
  "target": {
    "appId": "cu-backoffice",
    "surface": "web",
    "entrypoint": "{{env.APP_BASE_URL}}/login",
    "appFingerprint": {
      "titlePattern": "CU BackOffice - Teller",
      "markers": [{ "textPresent": "CU BackOffice v2" }]
    }
  },
  "inputs": [
    { "name": "memberId", "type": "string", "required": true, "pattern": "^\\d{5}$",
      "sensitive": false, "description": "Five-digit member number", "example": "12345" }
  ],
  "outputs": [
    { "name": "savingsBalance", "type": "money", "sensitive": true,
      "description": "Current savings balance", "sourceStep": "s7" },
    { "name": "memberName", "type": "string", "sensitive": true,
      "description": "Member display name", "sourceStep": "s6" }
  ],
  "steps": [
    { "id": "s1", "intent": "Open the teller login page", "action": "navigate",
      "value": "{{env.APP_BASE_URL}}/login",
      "checkpoint": { "all": [{ "elementVisible":
        { "kind": "role", "role": "button", "name": "Sign In" } }] },
      "risk": "safe" },
    { "id": "s2", "intent": "Log in as the teller", "action": "fill+submit",
      "target": { "strategies": [
          { "kind": "labelText", "value": "Operator ID" },
          { "kind": "css", "value": "#ctl00_login_txtOp" }],
        "elementDescription": "Operator ID field on login form", "framePath": [] },
      "value": { "operator": "{{secrets.tellerId}}",
                 "password": "{{secrets.tellerPassword}}" },
      "checkpoint": { "all": [{ "urlMatches": "/home" },
                              { "textPresent": "Member Services" }] },
      "risk": "safe" },
    { "id": "s3", "intent": "Enter the member number into the search field",
      "action": "fill",
      "target": { "strategies": [
          { "kind": "role", "role": "textbox", "name": "Member Number" },
          { "kind": "labelText", "value": "Member Number" },
          { "kind": "nearText", "value": "Member Number", "direction": "right" },
          { "kind": "css", "value": "#ctl00_pnlSrch_txtMbr" },
          { "kind": "bbox", "value": [412, 236, 180, 24] }],
        "elementDescription": "Member number input in the search panel",
        "framePath": [] },
      "value": "{{inputs.memberId}}",
      "waitBefore": { "condition": { "elementVisible":
        { "kind": "labelText", "value": "Member Number" } }, "timeoutMs": 5000 },
      "checkpoint": { "all": [{ "valueMatches":
        { "target": "self", "pattern": "{{inputs.memberId}}" } }] },
      "risk": "safe" },
    { "id": "s4", "intent": "Run the search", "action": "click",
      "target": { "strategies": [
          { "kind": "role", "role": "button", "name": "Search" },
          { "kind": "css", "value": "#ctl00_pnlSrch_btnGo" }],
        "elementDescription": "Search button", "framePath": [] },
      "checkpoint": { "any": [
          { "elementVisible": { "kind": "nearText", "value": "Member Results" } },
          { "textPresent": "No records found" }] },
      "risk": "safe" },
    { "id": "s5", "intent": "Open the member detail record", "action": "click",
      "target": { "strategies": [
          { "kind": "relativeTo",
            "anchor": { "kind": "text", "value": "{{inputs.memberId}}" },
            "relation": "row-link" },
          { "kind": "css", "value": "table#ctl00_grdRes a" }],
        "elementDescription": "Result row link for the searched member",
        "framePath": [] },
      "checkpoint": { "all": [
          { "urlMatches": "/members/{{inputs.memberId}}" }] },
      "risk": "safe" },
    { "id": "s6", "intent": "Read the member name", "action": "extract",
      "target": { "strategies": [
          { "kind": "nearText", "value": "Name:", "direction": "right" }],
        "elementDescription": "Member name value on detail header",
        "framePath": ["detailFrame"] },
      "extract": { "name": "memberName", "type": "string" },
      "checkpoint": { "all": [{ "textPresent": "Accounts" }] },
      "risk": "safe" },
    { "id": "s7", "intent": "Read the savings balance from the accounts table",
      "action": "extract",
      "target": { "strategies": [
          { "kind": "relativeTo",
            "anchor": { "kind": "text", "value": "Savings" },
            "relation": "row-cell", "cellHint": "Balance" },
          { "kind": "bbox", "value": [388, 402, 110, 20] }],
        "elementDescription": "Balance cell of the Savings row",
        "framePath": ["detailFrame"] },
      "extract": { "name": "savingsBalance", "type": "money" },
      "checkpoint": { "all": [{ "valueMatches":
        { "target": "self", "pattern": "^\\$[0-9,]+\\.\\d{2}$" } }] },
      "risk": "safe" }
  ],
  "outcomes": [
    { "code": "MEMBER_NOT_FOUND", "terminal": true,
      "description": "No member exists with the supplied member number.",
      "detector": { "all": [{ "textPresent": "No records found" },
                            { "elementAbsent":
                              { "kind": "nearText", "value": "Member Results" } }] } },
    { "code": "PERMISSION_DENIED", "terminal": true,
      "description": "Teller lacks access to this member record.",
      "detector": { "textPresent": "You do not have permission" } }
  ],
  "recoveries": [
    { "id": "maintenance-interstitial", "appliesTo": "global", "maxAttempts": 2,
      "detector": { "elementVisible":
        { "kind": "role", "role": "dialog", "name": "System Notice" } },
      "action": { "kind": "dismiss", "target": { "strategies": [
        { "kind": "role", "role": "button", "name": "OK" }] } } },
    { "id": "transient-slow-load", "appliesTo": "global", "maxAttempts": 2,
      "detector": { "textPresent": "Loading..." },
      "action": { "kind": "waitRetry", "backoffMs": 2000 } },
    { "id": "session-expiry-reauth", "appliesTo": "global", "maxAttempts": 1,
      "detector": { "urlMatches": "/login\\?expired=1" },
      "action": { "kind": "runSteps", "stepIds": ["s2"] } }
  ],
  "successCheckpoint": { "all": [
      { "urlMatches": "/members/{{inputs.memberId}}" },
      { "textPresent": "Accounts" }] },
  "policy": {
    "requiredOrigins": ["{{env.APP_BASE_URL}}"],
    "allowedActionKinds": ["navigate", "click", "fill", "extract"],
    "riskLevel": "readonly",
    "unattendedReplay": true
  },
  "provenance": {
    "provider": "anthropic", "model": "claude-sonnet-4-6",
    "runId": "disc_7f2e", "recordedAt": "2026-09-10T18:20:11Z",
    "evidenceRef": "evidence/disc_7f2e/", "reviewStatus": "approved"
  }
}
"""

RESULTS_JSON = r"""
// success
{ "status": "success",
  "outputs": { "savingsBalance": "$4,912.55", "memberName": "***REDACTED***" },
  "telemetry": { "steps": 7, "retries": 0, "maxFallbackDepth": 1,
                 "durationMs": 8412 },
  "evidenceRef": "evidence/replay_a8c3/" }

// business outcome (bad input 99999)
{ "status": "business_outcome", "code": "MEMBER_NOT_FOUND",
  "message": "No member exists with the supplied member number.",
  "evidenceRef": "evidence/replay_b911/" }

// hard failure (injected error500)
{ "status": "hard_failure",
  "error": { "stepId": "s4", "intent": "Run the search",
    "expected": { "any": [{ "elementVisible": "Member Results" },
                          { "textPresent": "No records found" }] },
    "observed": { "url": "/members/search", "title": "Server Error",
                  "topText": "HTTP 500 - internal error" },
    "evidencePaths": ["evidence/replay_x/screens/008_failure.png",
                       "evidence/replay_x/snapshots/008.json"] },
  "telemetry": { "steps": 4, "retries": 2, "maxFallbackDepth": 1 } }

// escalated (injected session expiry, human logged in, run resumed)
{ "status": "escalated",
  "intervention": { "id": "int_2026_0911_0142",
    "reason": "recovery_exhausted: session-expiry recovery failed",
    "resolution": "human_fixed_resumed" },
  "finalStatus": "success",
  "evidenceRef": "evidence/replay_c04d/" }
"""

POLICY_YAML = r"""
# policy.yaml - global guardrails (deny by default; artifacts may narrow,
# never widen, what this file allows)
allowlist:
  origins:
    - "http://localhost:4600"          # mock CU back-office
  routes:
    deny: ["**/admin/**"]              # never touched, even inside the origin
  actionKinds: [navigate, click, fill, select, press, extract, dismiss]

risk:
  riskyActionKinds: [submit]
  riskyUrlPatterns: ["**/subaccounts/new/confirm"]
  discoveryRiskyActions: require_approval     # always a human decision
  unattendedRiskyReplay: false                # approved artifacts still need
                                              #   policy to opt in per capability
budgets:
  maxSteps: 25
  stepTimeoutMs: 15000
  runTimeoutMs: 300000
  maxRecoveryAttemptsPerStep: 2

escalation:
  interventionTtlMinutes: 30            # stale interventions abort safely
  operatorConsole: "http://localhost:4700"

redaction:
  maskSecrets: always
  maskSensitiveParams: always
  screenshotMaskSensitiveFields: true
"""


def appendices():
    story = [H1("Appendix A - Complete example artifact (member-savings-lookup)")]
    story.append(P(
        "Internally consistent with Sections 5, 6, and 11; this is the shape the "
        "Recorder emits and the fixture the schema tests parse."))
    story.extend(code(ARTIFACT_FULL, small=True, chunk=52))
    story.append(PageBreak())
    story.append(H1("Appendix B - Result contract examples"))
    story.extend(code(RESULTS_JSON, chunk=44))
    story.append(sp(6))
    story.append(H1("Appendix C - policy.yaml"))
    story.extend(code(POLICY_YAML, chunk=44))
    return story
