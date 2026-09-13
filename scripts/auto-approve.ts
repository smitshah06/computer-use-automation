// Scripted operator for RISKY-ACTION approvals: polls the operator console's
// HTTP API and resolves pending `approval` interventions with approve_once —
// the same claim → resolve control path a human takes in the dashboard. Run it
// alongside `npm run discover` / `npm run replay` of a mutating capability
// when nobody is sitting at the console (evidence capture, CI).
//
// It only touches type:"approval" interventions; assist escalations (a human
// must fix the live session) are left for a real operator.
//
// The console requires a shared-secret token. Set SCRIBE_CONSOLE_TOKEN (in the
// environment or .env) so this script and the replay CLI use the SAME token —
// without it the CLI generates a random per-run token this script cannot know.
//
// Usage: SCRIBE_CONSOLE_TOKEN=... tsx scripts/auto-approve.ts [count] [timeoutSeconds]
//   count           approvals to grant before exiting (default 1)
//   timeoutSeconds  give up after this long (default 240)

import { existsSync, readFileSync } from "node:fs";
import { loadPolicyConfig } from "../src/policy/engine";
import type { InterventionRecord } from "../src/escalation/store";

const OPERATOR = "operator-jsmith";
const count = Number(process.argv[2] ?? "1");
const timeoutMs = Number(process.argv[3] ?? "240") * 1000;
if (!Number.isInteger(count) || count < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  // NaN would make the while-condition false and the script exit claiming success.
  console.error("usage: tsx scripts/auto-approve.ts [count >= 1] [timeoutSeconds > 0]");
  process.exit(2);
}

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const token = process.env.SCRIBE_CONSOLE_TOKEN;
  if (!token) {
    throw new Error(
      "SCRIBE_CONSOLE_TOKEN is not set. Export it (or add it to .env) before starting the replay " +
        "so the CLI's console and this script share one token.",
    );
  }
  const AUTH = { "x-scribe-token": token };
  const config = loadPolicyConfig("policy.yaml");
  const consoleUrl = `http://127.0.0.1:${config.escalation.operatorPort}`;
  const deadline = Date.now() + timeoutMs;
  const done = new Set<string>();

  console.log(`auto-approve: will approve ${count} risky-action request(s) at ${consoleUrl} as ${OPERATOR}`);
  while (done.size < count) {
    if (Date.now() > deadline) {
      console.error(`auto-approve: timed out with ${done.size}/${count} approvals granted`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));

    let list: InterventionRecord[];
    try {
      const res = await fetch(`${consoleUrl}/api/interventions`, { headers: AUTH });
      if (res.status === 401) throw new Error("console rejected the token — SCRIBE_CONSOLE_TOKEN mismatch");
      list = (await res.json()) as InterventionRecord[];
    } catch (e) {
      if (e instanceof Error && e.message.includes("token")) throw e;
      continue; // console not up yet — the run has not reached its risky step
    }
    // Credit approvals resolved by anyone (e.g. a human already at the console)
    // so the script exits instead of waiting out its timeout for finished work.
    for (const x of list) {
      if (x.request.type === "approval" && x.status === "resolved" && !done.has(x.request.id)) {
        done.add(x.request.id);
        console.log(
          `auto-approve: ${x.request.id} resolved externally (${x.resolution?.disposition ?? "?"}) (${done.size}/${count})`,
        );
      }
    }
    if (done.size >= count) break;

    // Prefer an approval this script already claimed but failed to resolve
    // (transient error last pass) — it is no longer "pending" and would
    // otherwise be skipped forever.
    const mine = list.find(
      (x) => x.status === "claimed" && x.claimedBy === OPERATOR && x.request.type === "approval" && !done.has(x.request.id),
    );
    const iv = mine ?? list.find((x) => x.status === "pending" && x.request.type === "approval" && !done.has(x.request.id));
    if (!iv) continue;

    const id = iv.request.id;
    if (!mine) {
      console.log(`auto-approve: pending approval ${id} — ${iv.request.reason}`);
      const claim = await fetch(`${consoleUrl}/api/interventions/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH },
        body: JSON.stringify({ operator: OPERATOR }),
      });
      if (!claim.ok) {
        console.error(`auto-approve: claim of ${id} failed (${claim.status})`);
        continue;
      }
    }
    const resolve = await fetch(`${consoleUrl}/api/interventions/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({
        disposition: "approve_once",
        operator: OPERATOR,
        note: "risky action reviewed and approved for this run only",
      }),
    });
    if (!resolve.ok) {
      console.error(`auto-approve: resolve of ${id} failed (${resolve.status})`);
      continue;
    }
    done.add(id);
    console.log(`auto-approve: approved ${id} (${done.size}/${count})`);
  }
  console.log("auto-approve: done");
}

main().catch((e: unknown) => {
  console.error(`auto-approve error: ${(e as Error).message}`);
  process.exit(2);
});
