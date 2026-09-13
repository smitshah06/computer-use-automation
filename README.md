# Scribe — record-once / replay-many computer-use automation

An LLM drives a real UI once to accomplish a natural-language goal. The successful run is
distilled into a **typed, versioned capability artifact**. From then on the artifact is replayed
**deterministically — no LLM in the loop** — with typed inputs/outputs, an explicit error
taxonomy, safety guardrails, and human escalation that takes over the *live* browser session.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how
> an AI agent invokes it in production.

The target is a locally served mock credit-union back-office ("CU BackOffice") built to be
deliberately legacy-hostile: server-rendered, nested-table layout, no test IDs, `ctl00_*`
auto-generated element IDs, plus fault injection for the runtime errors that matter (session
expiry, maintenance interstitials, slow loads, not-found, etc.).

Design write-up: [REPORT.md](REPORT.md). Extended design document (decision rationale,
alternatives considered): [docs/Implementation_Design_Plan.pdf](docs/Implementation_Design_Plan.pdf).

## Setup

Prereqs: Node 20+ (developed on 22).

```bash
npm install
npx playwright install chromium
cp .env.example .env        # then edit
```

`.env` keys:

| Variable | Needed for | Notes |
|---|---|---|
| `OPENAI_API_KEY` *or* `ANTHROPIC_API_KEY` | **discovery only** | pick provider with `--provider` / `SCRIBE_PROVIDER` |
| `SCRIBE_SECRET_TELLER_USERNAME` / `..._PASSWORD` | discovery + replay | demo app creds (`teller1` / `Demo!Pass1`); referenced by artifacts as `{{secrets.*}}`, resolved only at runtime, never persisted |

**Replay needs no LLM key at all** — that is the point. The committed capability
[capabilities/member-savings-lookup.json](capabilities/member-savings-lookup.json) replays with
just the two `SCRIBE_SECRET_*` vars set.

Running without live services: `npm test` (58 unit + integration tests) needs **no API key and no
running app** — integration tests boot their own target-app instances and drive the discovery
loop with a scripted provider double.

## Demo path

Terminal 1 — start the target app (http://localhost:4600, sign-in `teller1` / `Demo!Pass1`):

```bash
npm run target
```

Terminal 2:

```bash
# 1. DISCOVERY (uses your LLM key once): goal in, capability artifact out
npm run discover -- \
  --goal "Look up the member by member number and read their savings account balance" \
  --entry http://localhost:4600/login \
  --id member-savings-lookup --name "Member savings balance lookup" \
  --app cu-backoffice --input memberId=12345 --provider openai
# -> capabilities/member-savings-lookup.json (reviewStatus: draft)
# -> evidence/disc_<stamp>/  (run.jsonl, screenshots, artifact snapshot)

# 2. Review + approve (gates unattended replay of risky capabilities)
npm run approve -- --capability member-savings-lookup --reviewer you

# 3. DETERMINISTIC REPLAY (no LLM key): typed params in, typed outputs out
npm run replay -- --capability member-savings-lookup --param memberId=12345
# -> success { savingsBalance: "$1,204.55" }  + per-step locator-rank telemetry

# 4. Business outcome ≠ failure: unknown member is a declared, terminal answer
npm run replay -- --capability member-savings-lookup --param memberId=99999
# -> business_outcome MEMBER_NOT_FOUND

# 5. Recoverable condition: inject a maintenance dialog; declared recovery dismisses it
npm run replay -- --capability member-savings-lookup --param memberId=12345 --inject interstitial
# -> success, run.jsonl shows recovery_applied: maintenance-interstitial

# 6. ESCALATION: inject one-shot session expiry -> checkpoint fails -> intervention
npm run replay -- --capability member-savings-lookup --param memberId=12345 --inject session-expiry --headed
# then open the operator console at http://127.0.0.1:4700 :
#   claim -> re-authenticate in the headed browser window (same live session) ->
#   resolve "completed_step" -> engine re-verifies the checkpoint and resumes
# -> escalated { finalStatus: success, outputs: { savingsBalance: "$1,204.55" } }
```

Scripted variant of step 6 (no human needed — drives the operator through the same console
HTTP API, exercising the identical control-transfer path):

```bash
npx tsx scripts/capture-escalation.ts
```

Other commands: `npm run catalog` (list capabilities as an agent-facing contract summary),
`--inject slow|error500` (the other two injectable faults), `--headed` on any run, `--no-console`
to skip the operator console. Permission denials and validation errors need no injection — they
are natural app states (member `66666` is restricted for tellers; the deposit form rejects
amounts under $5).

## Committed evidence (`/evidence/`)

Every run writes `run.jsonl` (structured, redacted, actor-attributed log), `screenshots/` per
step and on failure, and `result.json` / `discovery-summary.json` (runs that produce or execute
an artifact also snapshot it as `artifact.json`). Because `savingsBalance` is marked `sensitive`,
committed `result.json` files show it as `"***"` — the values below are what the live terminal
prints.

| Directory | Scenario | Result |
|---|---|---|
| `disc_20260912173144` | **Real LLM discovery** (OpenAI `gpt-4o`, 9 turns) | recorded → `capabilities/member-savings-lookup.json` |
| `disc_20260912173538` | Real LLM discovery, member `99999` | declared `MEMBER_NOT_FOUND`, merged into the artifact |
| `replay_20260912173725` | Replay `memberId=12345` | `success`, `savingsBalance: "$1,204.55"` |
| `replay_20260912173732` | Replay `memberId=99999` | `business_outcome MEMBER_NOT_FOUND` |
| `replay_20260912173739` | Replay + injected interstitial | recovery `maintenance-interstitial` applied → `success` |
| `replay_escalation_20260912180848` | Replay + injected session expiry | `escalated` → operator claim → human re-auth in live session → `completed_step` → `finalStatus: success` |

The escalation log contains the full control-transfer audit trail: `control_transition`
`agent→paused` (system), `paused→human` (operator-jsmith), `human→agent` (operator-jsmith), five
`actor:"human"` actions with values masked, and `step_completed_by_human` with the re-verified
checkpoint.

## Repo layout

```
src/core/        Zod schemas: artifact, result contract, condition AST, policy config, templating
src/surface/     SurfaceDriver interface + PlaywrightDriver (a11y-tree perception, ranked locators)
src/policy/      PolicyEngine — enforced INSIDE driver.act(): the one chokepoint
src/llm/         LLMProvider seam + Anthropic/OpenAI adapters (discovery only)
src/agent/       discovery loop + Recorder (distills a run into a parameterized artifact)
src/replay/      deterministic executor + DeviationClassifier (NO import path to llm/ — enforced)
src/escalation/  control-ownership state machine, intervention store, operator console
src/evidence/    redacting JSONL run logger, screenshots, run directories
src/target-app/  mock CU back-office (legacy-hostile markup) + fault injection
src/cli/         discover / replay / approve / catalog
policy.yaml      deny-by-default allowlist: origins, action kinds, risky-action rules
```

## Checks

```bash
npm test            # 58 tests: schema, policy, classifier, escalation, driver, replay, discovery
npm run typecheck   # strict tsc
npm run lint        # eslint + dependency-boundary check (replay must not reach llm)
```
