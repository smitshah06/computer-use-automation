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
| `SCRIBE_CONSOLE_TOKEN` | optional | pins the operator-console auth token; unset, the CLI generates a random per-run token and prints the tokened URL. Set it when a script (e.g. `scripts/auto-approve.ts`) must call the console API |
| `SCRIBE_SIGNING_SECRET` | optional | key for HMAC-signing operator dispositions (defaults to the console token) |

**Replay needs no LLM key at all** — that is the point. The three committed capabilities in
[capabilities/](capabilities/) — a read-only balance lookup, a two-output standing check, and a
**mutating** sub-account opener — replay with just the two `SCRIBE_SECRET_*` vars set.

Running without live services: `npm test` (91 unit + integration tests) needs **no API key and no
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
# then open the operator console — the CLI prints its tokened URL
# (http://127.0.0.1:4700/?token=…; auth required since every disposition is signed):
#   claim -> re-authenticate in the headed browser window (same live session) ->
#   resolve "completed_step" -> engine re-verifies the checkpoint and resumes
# -> escalated { finalStatus: success, outputs: { savingsBalance: "$1,204.55" } }
```

Scripted variant of step 6 (no human needed — drives the operator through the same console
HTTP API, exercising the identical control-transfer path):

```bash
npx tsx scripts/capture-escalation.ts
```

### The other two committed capabilities

`member-standing-check` — read-only, **two typed outputs**, three terminal shapes from one artifact:

```bash
npm run replay -- --capability member-standing-check --param memberId=12345
# -> success { memberStatus: "Active", memberSince: "03/11/2014" }
npm run replay -- --capability member-standing-check --param memberId=45678
# -> success { memberStatus: "Dormant", ... } — recorded on member 12345; telemetry shows step s8
#    falling from the recorded-name locator to the parameterized nearText rank (drift signal)
npm run replay -- --capability member-standing-check --param memberId=66666
# -> business_outcome ACCESS_DENIED (restricted record — a declared answer, not an error)
npm run replay -- --capability member-standing-check --param memberId=99999
# -> business_outcome MEMBER_NOT_FOUND
```

`subaccount-open` — **mutating** (`riskLevel: mutating`, `unattendedReplay: false`): every replay
pauses at the risky submit until an operator approves that one action:

```bash
npm run replay -- --capability subaccount-open --param memberId=12345 \
  --param accountType=Checking --param "nickname=Rainy Day" --param depositAmount=40.00
# pauses at s13 -> in the console (CLI prints the tokened URL): claim -> resolve "approve_once"
# -> escalated { finalStatus: success, outputs: { confirmationNumber: "CU-2026-…" } }

npm run replay -- --capability subaccount-open --param memberId=12345 \
  --param "accountType=Holiday Club" --param "nickname=Vacation Fund" --param depositAmount=2.00
# -> escalated { finalStatus: business_outcome, code: DEPOSIT_BELOW_MINIMUM }  (deposit < $5.00)
```

No human at the console? Set `SCRIBE_CONSOLE_TOKEN` in `.env` (so the replay CLI's console and
the script share one token), then `npx tsx scripts/auto-approve.ts 1 240 &` first — a scripted
operator that grants the next approval through the same console HTTP API (claim →
`approve_once`), exercising the identical control-transfer path.

### Multi-tenant: replay the tenant-A artifact on a re-skinned tenant B

"CU North" is the same vendor product re-deployed for another institution — green branding,
`tw_*` element IDs instead of `ctl00_*`, member→customer vocabulary — served on its own port.
The committed overlay [tenants/cu-north.json](tenants/cu-north.json) adapts the artifact
**recorded on tenant A** at load time: no re-recording, no LLM.

```bash
# Terminal 1 — tenant B at http://localhost:4650
npm run target:north

# Terminal 2 — same artifact, overlay applied at load
npm run replay -- --capability member-savings-lookup --tenant cu-north --param memberId=12345
# -> success { savingsBalance: "$1,204.55" } — telemetry shows EVERY step resolved at rank 0
#    (role/labelText/nearText). Tenant A's ctl00_* css ranks never had to match tw_* markup:
#    the semantic-first locator thesis doing the work.
```

Without `--tenant` the artifact fails closed on tenant B: its `requiredOrigins` still pins
`localhost:4600`, so the entry navigation is denied at the policy chokepoint (proven in
`test/integration/tenant.test.ts`). The binding maps vocabulary by **exact** string equality
only, never touches mechanics (`urlMatches`, step values, extract patterns), refuses to merge
across different `appId`s, and the merged artifact is re-validated through the strict schema.

Other commands: `npm run catalog` (list capabilities as an agent-facing contract summary),
`npm run health` (locator-health report: per-step strategy-rank drift aggregated across the
committed evidence runs; `--ci` exits non-zero if any capability is drifting or broken),
`--inject slow|error500` (the other two injectable faults), `--headed` on any run, `--no-console`
to skip the operator console. Permission denials and validation errors need no injection — they
are natural app states (member `66666` is restricted for tellers; the deposit form rejects
amounts under $5). The target app's data is in-memory: each successful sub-account open mutates
it (appends an account, increments the confirmation number), so restart `npm run target` to reset
to the seed state.

## Committed evidence (`/evidence/`)

Every run writes `run.jsonl` (structured, redacted, actor-attributed log), `screenshots/` per
step and on failure, and `result.json` / `discovery-summary.json` (runs that produce or execute
an artifact also snapshot it as `artifact.json`). Because `savingsBalance` is marked `sensitive`,
committed `result.json` files show it as `"***"` — the values below are what the live terminal
prints. (The standing-check and sub-account outputs are declared non-sensitive, so their
`result.json` values are real.)

| Directory | Scenario | Result |
|---|---|---|
| `disc_20260912173144` | **Real LLM discovery** (OpenAI `gpt-4o`, 9 turns) | recorded → `capabilities/member-savings-lookup.json` |
| `disc_20260912173538` | Real LLM discovery, member `99999` | declared `MEMBER_NOT_FOUND`, merged into the artifact |
| `replay_20260912173725` | Replay `memberId=12345` | `success`, `savingsBalance: "$1,204.55"` |
| `replay_20260912173732` | Replay `memberId=99999` | `business_outcome MEMBER_NOT_FOUND` |
| `replay_20260912173739` | Replay + injected interstitial | recovery `maintenance-interstitial` applied → `success` |
| `replay_escalation_20260912180848` | Replay + injected session expiry | `escalated` → operator claim → human re-auth in live session → `completed_step` → `finalStatus: success` |
| `disc_20260913014228` | Discovery of `subaccount-open` (`gpt-4o`, 14 turns) — model labels the submit `risky`, pauses for approval mid-discovery | recorded → `capabilities/subaccount-open.json` (confirmation `CU-2026-4181`) |
| `disc_20260913014306` | Discovery, deposit `$2.00` | declared `DEPOSIT_BELOW_MINIMUM_REQUIREMENT` (renamed `DEPOSIT_BELOW_MINIMUM` in review), merged into the artifact |
| `disc_20260913014453` | Discovery of `member-standing-check` (`gpt-4o`, 10 turns) | recorded → `capabilities/member-standing-check.json` |
| `disc_20260913014750` | Discovery, member `66666` (restricted) | declared `ACCESS_DENIED`, merged |
| `disc_20260913014808` | Discovery, member `99999` | declared `MEMBER_NOT_FOUND`, merged |
| `replay_20260913015019` | Standing check `12345` | `success { memberStatus: "Active", memberSince: "03/11/2014" }` |
| `replay_20260913015027` | Standing check `45678` (artifact recorded on `12345`) | `success { memberStatus: "Dormant", memberSince: "10/17/2011" }` — telemetry: s8 fell to rank-1 `nearText` (drift signal) |
| `replay_20260913015036` | Standing check `66666` | `business_outcome ACCESS_DENIED` |
| `replay_20260913015045` | Standing check `99999` | `business_outcome MEMBER_NOT_FOUND` |
| `replay_20260913015057` | Sub-account open (mutating) `12345` / Checking / `$40.00` | paused at risky submit → `approve_once` (operator-jsmith) → `escalated`, `finalStatus: success`, `confirmationNumber: "CU-2026-4182"` |
| `replay_20260913015112` | Sub-account open, deposit `$2.00` | approved → app rejects deposit → `escalated`, `finalStatus: business_outcome DEPOSIT_BELOW_MINIMUM` |
| `replay_20260913151918` | **Cross-tenant replay** — tenant-A artifact + `tenants/cu-north.json` overlay on CU North (`:4650`) | `success`, every step at its rank-0 semantic locator; the snapshotted `artifact.json` is the merged overlay that actually executed |

The escalation log contains the full control-transfer audit trail: `control_transition`
`agent→paused` (system), `paused→human` (operator-jsmith), `human→agent` (operator-jsmith), eight
`actor:"human"` entries (three re-auth actions driven through the console plus five captured
input/click/navigate events from the live page) with values masked, and `step_completed_by_human`
with the re-verified checkpoint.

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
src/target-app/  mock CU back-office (legacy-hostile markup, two tenant skins) + fault injection
src/cli/         discover / replay / approve / catalog / health
tenants/         per-tenant binding overlays (cu-north.json — the CU North re-skin)
policy.yaml      deny-by-default allowlist: origins, action kinds, risky-action rules
```

## Checks

```bash
npm test            # 91 tests: schema, policy, classifier, escalation, driver, replay, discovery, tenant overlay
npm run typecheck   # strict tsc
npm run lint        # eslint + dependency-boundary check (replay must not reach llm)
```
