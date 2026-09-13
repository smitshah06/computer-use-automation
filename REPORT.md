# REPORT

Stack: TypeScript / Node, Playwright, Zod, Anthropic + OpenAI adapters, local mock
credit-union back-office as the target. Demo commands and committed evidence: [README.md](README.md).
A longer decision log (alternatives considered per choice) is in
[docs/Implementation_Design_Plan.pdf](docs/Implementation_Design_Plan.pdf).

## Architecture

A modular monolith, one process, CLI-driven. The brief rewards judgment over infrastructure, so
the boundaries live in module contracts enforced by a dependency-rule check
(`scripts/depcheck.mjs`, run in `npm run lint`) rather than in services and queues. Two rules are
load-bearing:

- **`replay/` has no import path to `llm/`.** "Deterministic replay never consults a model" is a
  property of the build, not a convention — the lint fails if anyone adds the import.
- **The `PolicyEngine` is called inside `SurfaceDriver.act()`**, not by callers. Discovery and
  replay share the only door to the UI, so neither can act outside policy by construction.

Flow: `discover` runs an observe → decide → act loop (one forced tool call per turn against a
neutral `LLMProvider` seam; Anthropic and OpenAI adapters are ~60 lines each) and feeds a
`Recorder`; on success the run is distilled into a capability artifact. `replay` executes the
artifact with typed params and returns a typed result. On unrecoverable deviation the run pauses
and an intervention is raised to a localhost operator console; the human fixes the *same live
browser session* and hands back. Perception is accessibility-tree-first (role/name/value/bbox
snapshots), not raw DOM — chosen because the target class has no clean DOM, and because the same
abstraction exists on desktop (UIA/AX), which keeps the surface seam honest. The target app is
local and deliberately legacy-hostile (nested tables, no test IDs, `ctl00_*` IDs) with fault
injection — a public demo site cannot produce session expiry or permission denials on demand,
and those runtime states are the actual hard part.

## Artifact schema

`src/core/artifact.ts` (Zod, runtime-validated; example: `capabilities/member-savings-lookup.json`).
The schema is split by *who reads it*:

- **Contract** — `capability` (id, semver, description), typed `inputs` (validation pattern,
  `sensitive`), typed `outputs` (type, `sourceStep`), declared `outcomes`. This is all a calling
  agent or human reviewer needs; `catalog` prints exactly this.
- **Mechanics** — ordered `steps` (id, human-readable `intent` distilled from model reasoning,
  action, target, value/url, optional `waitBefore`, per-step `checkpoint`), `recoveries`,
  `successCheckpoint`. Only the replay engine reads this.
- **Policy + provenance** — `requiredOrigins`, `allowedActionKinds`, `riskLevel`,
  `unattendedReplay`; provider/model/runId/evidence ref and `reviewStatus: draft|approved`.

Key shapes and why:

- **Targets are ranked strategy lists**, semantic-first: `role` → `labelText` → `nearText` →
  `css` → `bbox`, plus a prose `elementDescription`. Semantic strategies survive re-branding and
  produce reviewable artifacts; CSS is a per-tenant-patchable last resort; bbox + description is
  the fallback a pure-vision or desktop driver would use. Replay records *which rank matched* per
  step — the drift signal.
- **Conditions are a tiny declarative AST** (`all/any/urlMatches/textPresent/elementVisible/valueMatches`)
  — serializable, surface-agnostic, no eval. Checkpoints, outcome detectors, recovery detectors,
  and waits all share it.
- **Parameterization happens at record time.** The Recorder canonicalizes recorded literals into
  `{{inputs.*}}` (including inside URLs, locator strategies, and checkpoint regexes — see s8's
  checkpoint `/members/{{inputs.memberId}}`), the app origin into `{{env.APP_BASE_URL}}`, and
  credentials stay as `{{secrets.*}}` templates. Reuse and redaction are the same mechanism: raw
  values never enter the artifact.
- **Business outcomes are first-class**, versioning is three-layered (`schemaVersion` for format
  migrations, `capability.version` for flow semantics, `appFingerprint` to fail fast on a
  wrong/upgraded app), and `reviewStatus` gates unattended risky replay.

All three committed artifacts were recorded by real `gpt-4o` runs, then human-reviewed — the
lifecycle doing its job (diff the as-recorded drafts, `evidence/disc_*/artifact.json`, against
what was approved). Review caught real hazards. Balance lookup: an `extractPattern`
(`\$[\d,]+\.\d{2}`) after the first replay returned the whole account row text, a `sensitive`
flag, two recoveries. `subaccount-open`: the risky submit gained a
`textPresent: "Sub-Account Created"` checkpoint so a rejected form cannot fall through to the
confirmation extract, which itself gained a capture-group pattern (`(CU-\d{4}-\d+)`).
`member-standing-check`: the success checkpoint gained `textPresent: "Member Profile"` because
the access-denied page shares the profile URL, and the `ACCESS_DENIED` detector was trimmed to
an id-free phrase so it matches any restricted member, not just the one seen in discovery.

## Determinism & error handling

Replay executes per step: bounded `waitBefore` → resolve target through strategy ranks, where a
strategy must match **exactly one** element (zero matches falls through to the next rank; more
than one aborts the whole resolve — never guess at which twin is right) → policy check → act via
Playwright actionability → verify `checkpoint`. No sleeps; every
wait is a named condition with a bounded timeout. No LLM anywhere (enforced, see Architecture).

Any deviation runs the `DeviationClassifier` in strict precedence:

1. **Declared business outcome** detector matches → return `business_outcome`. A legitimate
   answer, not an error — the committed artifacts declare `MEMBER_NOT_FOUND`, `ACCESS_DENIED`,
   and `DEPOSIT_BELOW_MINIMUM`, each reached naturally in evidence, no fault injection needed.
2. **Declared recovery** matches → apply it (`dismiss` a known dialog, `waitRetry` with backoff,
   `runSteps` e.g. re-auth), bounded by `maxAttempts`, logged, then re-attempt the step.
3. Else **hard failure**: capture screenshot + a11y snapshot + URL, return
   `{stepId, intent, expected, observed, evidencePaths}` — and raise an intervention.

The result contract is a discriminated union — `success{outputs} | business_outcome{code} |
hard_failure{error} | escalated{interventions, finalStatus}` — so callers branch on structure,
not on string matching. Every run also returns per-step telemetry (strategy rank used, attempts,
durations). UI drift, the secondary concern: rising fallback-rank usage is the early-warning
signal — live in `evidence/replay_20260913015027`, where a standing check recorded on member
`12345` replays against `45678` and step s8 falls from the recorded-name locator to the
parameterized `nearText` rank. `appFingerprint` mismatch fails fast at entry, and evidence
bundles make locator failures diagnosable (`evidence/replay_20260912173739` shows an injected
interstitial detected and dismissed mid-run).

## Heterogeneity & multi-tenant

The seam: **the artifact records *what* to find and verify (semantic descriptors + declarative
conditions); the driver owns *how* to perceive and act.** `SurfaceDriver` is
`observe() / act() / evalCondition()` over `{role, name, value, state, bbox, frame}` nodes.
A legacy web app is already the implemented case (the mock app is framesets-era markup). A
desktop driver (UIA on Windows, AX on macOS) consumes the same artifact because those APIs
expose the same role/name tree — `role`/`labelText`/`nearText` strategies and the condition AST
carry over unchanged; `css` ranks are simply skipped. A vision driver resolves via
`elementDescription` + recorded bbox and text anchors. That is why every step carries
description and bbox even though the web driver rarely needs them.

Multi-tenant: hundreds of institutions run the same vendor product re-branded and re-versioned.
The design is one **base artifact per vendor product** plus a thin per-tenant **binding overlay**
— `{entrypoint, credentialsRef, per-step locator overrides, vocabulary map ("Member"→"Customer"),
appFingerprint}` — merged at load. Semantic-first locators make most overrides unnecessary;
when a tenant skins differ, you patch one strategy list, not re-record. Drift management:
strategy-rank telemetry aggregated per tenant/app-version gives a locator-health signal;
fingerprint mismatch blocks the run before any action; re-validation is a canary replay, and a
bounded LLM-assisted re-discovery that *proposes* a locator patch for human approval is the
designed (not built) repair path.

## Escalation & handoff

Stuck detection — discovery: identical action-signature repeated (warn at 3, terminal at 4), max
turns, model declares stuck, or a policy block on a risky action; replay: classifier step 3, or
checkpoint still failing after recoveries are exhausted.

Control transfer is an explicit ownership state machine on the run: `agent → paused → human →
agent | aborted`. The engine parks awaiting the gateway; every transition is logged with
who/when/why. The intervention record carries capability, step id + intent, the reason
(expected vs observed), screenshot, and live URL. The operator console (localhost:4700) is
deliberately minimal — the *mechanism* is the point: the browser runs headed, and the human
operates **the same browser context** the automation was using (same cookies, same page), not a
fresh session. Human actions are recorded into the same `run.jsonl` as `actor:"human"` with
sensitive values masked. Handback dispositions: `completed_step` (engine **re-verifies the failed
step's own checkpoint** before continuing — trust but verify), `fixed_environment` (re-attempt
the step), `abort`. Risky-action approval reuses the identical pipeline as intervention type
`approval` — one mechanism, two uses, both in committed evidence: the session-expiry assist
below, and every `subaccount-open` replay (e.g. `evidence/replay_20260913015057`).

Evidence: `evidence/replay_escalation_20260912180848` — injected one-shot session expiry, s4
checkpoint fails, intervention raised, operator claims, re-authenticates in the live session,
resolves `completed_step`, engine resumes and finishes `escalated{finalStatus: success}` with
the full audit trail. Production path for remote operators (CDP screencast / noVNC) is designed,
not built.

## Safety

Deny-by-default allowlist in `policy.yaml`: permitted origins, permitted action kinds, risky
action rules. It is enforced at the single chokepoint inside `driver.act()`; during discovery
the engine is additionally bound to global policy, during replay to the artifact's declared
policy — the model asking nicely cannot widen it, which is also the prompt-injection stance:
on-screen text is untrusted data and the chokepoint holds regardless of what the model decides.

Risk classes: reads/navigation are `safe`; mutating submits are `risky`. Discovery always
requires an approval intervention before a risky act. Replay executes risky steps unattended
only if the artifact is `approved` *and* policy allows; otherwise it pauses for approval. The
committed `subaccount-open` capability pins that gate open — `riskLevel: mutating`,
`unattendedReplay: false` — so every replay pauses at the submit ("capability policy forbids
unattended risky actions") until an operator grants `approve_once`
(`evidence/replay_20260913015057`). The asymmetry is deliberate for banking: a blocked action
costs seconds, a wrong irreversible write is unbounded.

Redaction is layered: credentials exist only as `{{secrets.*}}` templates resolved from env at
act time; the perception layer masks secret values before the model sees them; the run logger
redacts sensitive values (`"***"`) including human-phase actions; screenshots of sensitive fills
are masked; the Recorder's parameterization keeps raw inputs out of artifacts; raw model
transcripts are not persisted — only distilled intents. Tests assert the hygiene (artifact and
logs contain templates, never `Demo!Pass1`). Limits: the localhost operator console is
unauthenticated (demo scope); extracted business data is governed only by per-field `sensitive`
flags, not content-aware DLP; redaction is exact-value masking, so a secret echoed by the app in
a transformed form would not be caught.

## Cuts

Deliberate, at clean seams: **operator console** is a bare localhost page (no auth, no
screencast — the control-transfer model is real, the UI is not the point). **Desktop and vision
drivers** are designed, not built — the artifact already records what they need. **Tenant
overlays** are a designed schema, not code; no second app variant was built. **Assisted
fallback** (bounded LLM repair on replay failure) is designed but cut to keep replay purity
undiluted. Three capabilities are recorded against one app (read-only lookup, two-output
standing check, mutating opener) — a demonstration set, not a cross-app library. Stretch goals
picked: **approval gating**
(`draft → approved` via `npm run approve`) and the **agent-facing catalog** (`npm run catalog`
prints the contract view; `replay --capability <id> --param k=v` is the typed invocation).

Next, in order: tenant binding overlay + a re-skinned app variant to prove cross-tenant replay;
locator-health reporting from the already-collected strategy-rank telemetry; CDP-based remote
operator takeover; assisted-fallback repair proposals as reviewed artifact patches.
