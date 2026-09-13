// Scripted operator for RISKY-ACTION approvals: polls the operator console's
// HTTP API and resolves pending `approval` interventions with approve_once —
// the same claim → resolve control path a human takes in the dashboard. Run it
// alongside `npm run discover` / `npm run replay` of a mutating capability
// when nobody is sitting at the console (evidence capture, CI).
//
// It only touches type:"approval" interventions; assist escalations (a human
// must fix the live session) are left for a real operator.
//
// Usage: tsx scripts/auto-approve.ts [count] [timeoutSeconds]
//   count           approvals to grant before exiting (default 1)
//   timeoutSeconds  give up after this long (default 240)

import { loadPolicyConfig } from "../src/policy/engine";
import type { InterventionRecord } from "../src/escalation/store";

const OPERATOR = "operator-jsmith";
const count = Number(process.argv[2] ?? "1");
const timeoutMs = Number(process.argv[3] ?? "240") * 1000;

async function main(): Promise<void> {
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
      list = (await (await fetch(`${consoleUrl}/api/interventions`)).json()) as InterventionRecord[];
    } catch {
      continue; // console not up yet — the run has not reached its risky step
    }
    const iv = list.find((x) => x.status === "pending" && x.request.type === "approval" && !done.has(x.request.id));
    if (!iv) continue;

    const id = iv.request.id;
    console.log(`auto-approve: pending approval ${id} — ${iv.request.reason}`);
    const claim = await fetch(`${consoleUrl}/api/interventions/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operator: OPERATOR }),
    });
    if (!claim.ok) {
      console.error(`auto-approve: claim of ${id} failed (${claim.status})`);
      continue;
    }
    const resolve = await fetch(`${consoleUrl}/api/interventions/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
