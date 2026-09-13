# REPORT

Stack: TypeScript / Node, Playwright, Zod, Anthropic + OpenAI adapters, local mock
credit-union back-office as the target. Demo commands and committed evidence: [README.md](README.md).
A longer decision log (alternatives considered per choice) is in
[docs/Implementation_Design_Plan.pdf](docs/Implementation_Design_Plan.pdf).

## Architecture

A modular monolith, one process, CLI-driven. The brief rewards judgment over infrastructure, so
the boundaries live in module contracts enforced by a dependency-rule check
(`scripts/depcheck.mjs`, run in `npm run lint`). Two rules are load-bearing:

- **`replay/` has no import path to `llm/`.** "Deterministic replay never consults a model" is a
  property of the build, not a convention — lint fails if anyone adds the import.
- **The `PolicyEngine` is called inside `SurfaceDriver.act()`**, not by callers. Discovery and
  replay share the only door to the UI, so neither can act outside policy by construction.

Flow: `discover` runs an observe → decide → act loop (one forced tool call per turn against a
neutral `LLMProvider` seam; the Anthropic and OpenAI adapters are ~60 lines each) and feeds a
`Recorder`; on success the run is distilled into a capability artifact. `replay` executes the
artifact with typed params and returns a typed result; on unrecoverable deviation it pauses and
raises an intervention to a localhost operator console, where a human fixes the *same live
browser session* and hands back. Perception is accessibility-tree-first (role/name/value/bbox
snapshots), not raw DOM — the target class has no clean DOM, and the same abstraction exists on
desktop (UIA/AX), which keeps the surface seam honest. The target app is local and deliberately
legacy-hostile (nested tables, no test IDs, `ctl00_*` IDs) with fault injection — a public demo
site cannot produce session expiry or permission denials on demand, and those runtime states are
the actual hard part.

## Artifact schema

`src/core/artifact.ts` (Zod, runtime-validated; example: `capabilities/member-savings-lookup.json`).
The schema is split by *who reads it*:

- **Contract** — `capability` (id, semver, description), typed `inputs` (validation pattern,
  `sensitive`), typed `outputs` (type, `sourceStep`), declared `outcomes`. All a calling agent or
  reviewer needs; `catalog` prints exactly this.
- **Mechanics** — ordered `steps` (id, human-readable `intent` distilled from model reasoning,
  action, target, value/url, optional `waitBefore`, per-step `checkpoint`), `recoveries`,
  `successCheckpoint`. Only the replay engine reads this.
- **Policy + provenance** — `requiredOrigins`, `allowedActionKinds`, `riskLevel`,
  `unattendedReplay`; provider/model/runId and `reviewStatus: draft|approved`.

Key shapes and why:

- **Targets are ranked strategy lists**, semantic-first: `role` → `labelText` → `nearText` →
  `css` → `bbox`, plus a prose `elementDescription`. Semantic strategies survive re-branding;
  CSS is a per-tenant-patchable last resort; bbox + description is what a vision or desktop
  driver would use. Replay records *which rank matched* per step — the drift signal.
- **Conditions are a tiny declarative AST** (`all/any/not/urlMatches/textPresent/elementVisible/elementAbsent/valueMatches`)
  — serializable, surface-agnostic, no eval. Checkpoints, outcome detectors, recovery detectors,
  and waits all share it.
- **Parameterization happens at record time.** The Recorder canonicalizes recorded literals into
  `{{inputs.*}}` (including inside URLs, locator strategies, and checkpoint regexes), the app
  origin into `{{env.APP_BASE_URL}}`; credentials stay `{{secrets.*}}` templates. Reuse and
  redaction are the same mechanism: raw values never enter the artifact, and distill refuses to
  emit an artifact in which a sensitive literal survived.
- **Business outcomes are first-class**; versioning is three-layered (`schemaVersion` for format,
  `capability.version` for flow semantics, `appFingerprint` to fail fast on the wrong app);
  `reviewStatus` gates unattended risky replay.

All three committed artifacts were recorded by real `gpt-4o` runs, then human-reviewed (diff the
as-recorded drafts in `evidence/disc_*/artifact.json` against what was approved). Review caught
real hazards: the balance lookup gained an `extractPattern` (the first replay returned the whole
account row), a `sensitive` flag, and two recoveries; `subaccount-open`'s risky submit gained a
`textPresent: "Sub-Account Created"` checkpoint so a rejected form cannot fall through to the
confirmation extract; `member-standing-check`'s `ACCESS_DENIED` detector was trimmed to an
id-free phrase so it matches any restricted member, not just the one seen in discovery.

## Determinism & error handling

Replay executes per step: bounded `waitBefore` → resolve the target through strategy ranks,
where a strategy must match **exactly one** element (zero falls through to the next rank; more
than one aborts the resolve — never guess at which twin is right) → policy check → act via
Playwright actionability → verify `checkpoint`. No sleeps; every wait is a named condition with
a bounded timeout. No LLM anywhere (enforced — see Architecture).

Any deviation runs the `DeviationClassifier` in strict precedence:

1. **Declared business outcome** matches → return `business_outcome`. A legitimate answer, not
   an error — the artifacts declare `MEMBER_NOT_FOUND`, `ACCESS_DENIED`, `DEPOSIT_BELOW_MINIMUM`,
   each reached naturally in committed evidence.
2. **Declared recovery** matches → apply it (`dismiss` a known dialog, `waitRetry` with backoff,
   `runSteps` e.g. re-auth), bounded by `maxAttempts`, logged, re-attempt the step.
3. Else **hard failure**: capture screenshot + a11y snapshot + URL, return
   `{stepId, intent, expected, observed, evidencePaths}` — and raise an intervention.

The result contract is a discriminated union — `success{outputs} | business_outcome{code} |
hard_failure{error} | escalated{interventions, finalStatus}` — so callers branch on structure,
not string matching. Every run returns per-step telemetry (strategy rank used, attempts,
durations) on every exit path, including failures. Drift is managed with that telemetry: in
`evidence/replay_20260913015027` a standing check recorded on member `12345` replays against
`45678` and step s8 falls from the recorded-name locator to the parameterized `nearText` rank.
`npm run health` aggregates rank usage per capability/step across all evidence runs into
`healthy | drifting | broken` (`--ci` exits non-zero on drift — a canary gate). `appFingerprint`
mismatch fails fast at entry; evidence bundles make locator failures diagnosable
(`evidence/replay_20260912173739` shows an injected interstitial detected and dismissed mid-run).

## Heterogeneity & multi-tenant

The seam: **the artifact records *what* to find and verify (semantic descriptors + declarative
conditions); the driver owns *how* to perceive and act.** `SurfaceDriver` is
`observe() / act() / evalCondition()` over `{role, name, value, state, bbox, frame}` nodes.
Legacy web is the implemented case. A desktop driver (UIA/AX) consumes the same artifact because
those APIs expose the same role/name tree — semantic strategies and the condition AST carry over;
`css` ranks are skipped. A vision driver resolves via `elementDescription` + recorded bbox —
which is why every step carries both even though the web driver rarely needs them.

Multi-tenant: hundreds of institutions run the same vendor product re-branded, so the unit of
authorship is one **base artifact per vendor product** plus a thin per-tenant **binding overlay**
— built, not just designed: `src/core/tenant.ts` + [tenants/cu-north.json](tenants/cu-north.json),
merged at load by `replay --tenant cu-north`. The overlay carries `{entrypoint, requiredOrigins,
appFingerprint, vocabulary map ("Member"→"Customer"), last-resort per-step strategy overrides}`;
vocabulary maps on exact string equality only, mechanics are never mapped, the merge refuses to
cross `appId`s, and the merged artifact is re-validated through the strict schema. The mock app
ships the second tenant ("CU North": re-skinned, `tw_*` IDs, customer vocabulary, port 4650), and
`evidence/replay_20260913151918` replays the artifact *recorded on tenant A* against it: every
step resolves at rank 0 via role/label/text — tenant A's `ctl00_*` css ranks never had to match —
while without the overlay the artifact's own origin pin denies the run at entry (fail closed, in
the integration suite). Repair path (designed, not built): a bounded LLM-assisted re-discovery
that *proposes* a locator patch for human approval.

## Escalation & handoff

Stuck detection — discovery: identical action-signature repeated (warn at 3, terminal at 4), turn
budget, wall-clock deadline, model declares stuck, or an operator abort at the risky-action
approval gate (a deny hands control back and the model tries another route). Replay: classifier
step 3, or checkpoint still failing after recoveries are exhausted.

Control transfer is an explicit ownership state machine on the run: `agent → paused → human →
agent | aborted`. The engine parks awaiting the gateway; every transition is logged with
who/when/why into a hash chain whose genesis is seeded with the runId. The intervention record
carries capability, step id + intent, expected vs observed, screenshot, live URL. The operator
console (localhost:4700, shared-token auth — random per run unless `SCRIBE_CONSOLE_TOKEN` pins
it) is deliberately minimal; the *mechanism* is the point: the browser runs headed and the human
operates **the same browser context** the automation was using (same cookies, same page), not a
fresh session. Human actions are recorded into the same `run.jsonl` as `actor:"human"`, masked.
Handback dispositions: `completed_step` (the engine **re-verifies the failed step's own
checkpoint** before continuing — trust but verify), `fixed_environment` (re-attempt),
`abort`. Each resolution is HMAC-signed over a payload binding the intervention to its run,
capability, step, disposition, operator, note, and the custody-chain head at hand-back —
`verifyResolution`/`verifyResolutionForRecord` make after-the-fact edits to the approval trail
detectable. Risky-action approval reuses the identical pipeline as intervention type `approval` —
one mechanism, two uses, both in committed evidence.

Evidence: `evidence/replay_escalation_20260912180848` — injected one-shot session expiry, s4
checkpoint fails, intervention raised, operator claims, re-authenticates in the live session,
resolves `completed_step`, engine resumes and finishes `escalated{finalStatus: success}` with the
full audit trail. Remote-operator takeover (CDP screencast / noVNC) is designed, not built.

## Safety

Deny-by-default allowlist in `policy.yaml`: permitted origins, action kinds, risky-action rules —
enforced at the single chokepoint inside `driver.act()`; during replay the engine is additionally
bound to the artifact's declared policy. The model asking nicely cannot widen it, which is also
the prompt-injection stance: on-screen text is untrusted data and the chokepoint holds regardless
of what the model decides. Below the chokepoint sits a network backstop: every request the
browser context makes is origin-checked in-flight; responses are fetched with redirects disabled
and the first `Location` is vetted before the browser ever sees a 3xx; deeper redirect hops —
the one kind of traffic Playwright routes cannot intercept — are watched on the request stream,
and an off-allowlist hop tears the browser context down and fails the run closed (probing the
chain from Node was tried and rejected: it executes each hop twice, which corrupts one-shot
server state like session expiry). Service workers are blocked and WebSockets denied. A
page-initiated redirect or injected script cannot quietly carry the session, or its data, to an
origin policy never approved — even between actions, where `act()` is not looking.

Risk classes: reads/navigation are `safe`; mutating submits are `risky`. Discovery always
requires an approval intervention before a risky act. Replay executes risky steps unattended only
if the artifact is `approved` *and* policy allows; otherwise it pauses for approval, and an
`approve_once` is consumed by exactly one executed attempt — a retry must re-escalate, so a stale
approval can never double-submit. The committed `subaccount-open` capability pins the gate open
(`unattendedReplay: false`), so every replay pauses at the submit until an operator grants
`approve_once` (`evidence/replay_20260913015057`). The asymmetry is deliberate for banking: a
blocked action costs seconds; a wrong irreversible write is unbounded.

Redaction is layered: credentials exist only as `{{secrets.*}}` templates resolved from env at
act time; the perception layer masks secret values before the model sees them; the run logger
masks sensitive values (exact and URL-encoded forms), including human-phase actions; screenshots
of sensitive fills are masked; the Recorder keeps raw inputs out of artifacts and refuses to emit
one where a sensitive literal survived. The provider message arrays are never persisted — what is
stored is a per-turn decision log (chosen tool, masked input, the model's stated reasoning): the
run's "why" evidence, decoupled from the raw transcript. Limits, stated honestly: the discovery
model necessarily sees what the page shows, so protection there is contractual, not technical;
extracted business data is governed by per-field `sensitive` flags, not content-aware DLP;
exact-value masking would miss a secret the app echoes in transformed form; and the default
signing key derives from the console token — real non-repudiation needs per-operator keys, which
is identity infrastructure out of demo scope.

## Cuts

Deliberate, at clean seams: the **operator console** is a minimal localhost page (token-authed,
signed dispositions — no screencast: the control-transfer model is real, the UI is not the
point). **Desktop and vision drivers** are designed, not built — the artifact already records
what they need. **Assisted fallback** (bounded LLM repair on replay failure) is designed but cut
to keep replay purity undiluted. Three capabilities against one vendor product (read-only lookup,
two-output standing check, mutating opener) — a demonstration set, not a cross-app library,
though the product runs as two tenants. Stretch goals picked (two): **canonicalization &
cross-tenant reuse** (record-time parameterization plus the tenant-A artifact replayed on the
re-skinned CU North via the committed overlay) and the **agent-facing catalog** (`npm run
catalog` prints the contract view; `replay --capability <id> --param k=v` is the typed
invocation). The `draft → approved` state exists because the risky-action gate requires it — the
confidence-*scoring* half of that stretch item is not built.

With more time, in rough order of value:

**Security & trust.** Move the redirect backstop from detect-and-kill to true prevention by
intercepting at CDP `Fetch.requestPaused`, which — unlike Playwright routes — pauses every
redirect hop at request stage before egress (Chromium-only; a driver-internal rewrite behind the
same seam). Replace the shared console token with per-operator OIDC and sign dispositions with
per-operator KMS keys (ES256): an auditor then proves *which teller* approved the submit, where
HMAC only proves "someone holding the shared key". Add content-aware DLP before an evidence
bundle seals — Luhn-checked PANs, SSN shapes, NER over `run.jsonl`, an OCR pass over
screenshots — catching sensitive values the artifact never declared.

**Robustness at scale.** A stability harness replaying each capability ~50× across injected
fault mixes, publishing a per-step flakiness score into the locator-health report — a step that
needs its third-rank CSS locator in 20% of runs gets flagged before it breaks. Canary
re-validation on `appFingerprint` drift: read-only capabilities auto-run against a canary tenant
and failing artifacts are quarantined rather than discovered broken in production.

**Capability lifecycle.** Assisted fallback as *reviewed patches*: when one step's locator dies,
invoke the LLM for that step only and emit a proposed artifact diff (new strategy ranked above
the broken one) requiring human approval — bounded re-discovery as a code-reviewed change, never
silent self-healing. A registry replacing files-in-repo: content-addressed artifacts, signed at
approval time, with `schemaVersion` migration scripts replay refuses to bypass. Record-time
confidence scoring (locator depth + checkpoint specificity) to complete the stretch item's
unbuilt half.

**Surfaces.** A desktop UIA/AX driver — the OS accessibility tree yields the same
`{role, name, value, bbox}` node shape, so web-recorded semantic strategies replay against a
WinForms teller app — and a vision driver resolving via `elementDescription` + recorded bbox
hints for tree-less surfaces (Citrix/VDI). Both slot behind `SurfaceDriver`; the artifact
already records what they need.

**Operations.** Remote operator takeover via CDP screencast/noVNC so the same-live-session
property survives the operator being remote; OpenTelemetry spans mapping 1:1 onto the existing
`run.jsonl` events; secrets from a manager instead of env; and extending the custody hash chain
to cover each `human_action` event, so a tampered keystroke log breaks the chain exactly as a
tampered transition does.
