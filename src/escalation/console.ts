import { createServer, type Server } from "node:http";
import { resolve, sep } from "node:path";
import express, { type Request, type Response } from "express";
import type { InterventionResolution } from "../core";
import type { OperatorGateway } from "./gateway";

const RESOLVABLE = new Set(["fixed_environment", "completed_step", "approve_once", "deny", "abort"]);

export interface ConsoleOptions {
  port: number; // config.escalation.operatorPort
  runDir: string; // for serving intervention screenshots
}

// Local decision surface for a human operator. The browser session itself is
// the headed Playwright window on the same machine; this console only lists
// interventions, hands over/gives back control, and records dispositions.
// Bound to 127.0.0.1 by design — remote operators are a documented production
// concern (CDP screencast), not built here.
export class OperatorConsole {
  private server?: Server;

  constructor(
    private readonly gateway: OperatorGateway,
    private readonly opts: ConsoleOptions,
  ) {}

  start(): Promise<void> {
    const app = express();
    app.use(express.json());

    app.get("/api/interventions", (_req: Request, res: Response) => {
      res.json(this.gateway.store.list());
    });

    app.post("/api/interventions/:id/claim", (req: Request, res: Response) => {
      const operator = typeof req.body?.operator === "string" ? req.body.operator.trim() : "";
      if (!operator) return res.status(400).json({ error: "operator name required" });
      try {
        res.json(this.gateway.claim(String(req.params.id), operator));
      } catch (e) {
        res.status(409).json({ error: String((e as Error).message) });
      }
    });

    app.post("/api/interventions/:id/resolve", (req: Request, res: Response) => {
      const { disposition, operator, note } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof disposition !== "string" || !RESOLVABLE.has(disposition)) {
        return res.status(400).json({ error: `disposition must be one of: ${[...RESOLVABLE].join(", ")}` });
      }
      // Dispositions are accountability records: an anonymous hand-back would
      // leave a hole in the chain of custody.
      if (typeof operator !== "string" || !operator.trim()) {
        return res.status(400).json({ error: "operator name required" });
      }
      const resolution: InterventionResolution = {
        disposition: disposition as InterventionResolution["disposition"],
        operator: operator.trim(),
        note: typeof note === "string" && note.trim() ? note.trim() : undefined,
      };
      try {
        res.json(this.gateway.resolve(String(req.params.id), resolution));
      } catch (e) {
        res.status(409).json({ error: String((e as Error).message) });
      }
    });

    app.get("/shot/:id", (req: Request, res: Response) => {
      const rec = this.gateway.store.get(String(req.params.id));
      const rel = rec?.request.screenshotPath;
      if (!rel) return res.status(404).end();
      const base = resolve(this.opts.runDir);
      const abs = resolve(base, rel);
      if (!abs.startsWith(base + sep)) return res.status(400).end();
      res.sendFile(abs, (err) => {
        if (err) res.status(404).end();
      });
    });

    app.get("/", (_req: Request, res: Response) => {
      res.type("html").send(DASHBOARD_HTML);
    });

    return new Promise((resolvePromise) => {
      this.server = createServer(app);
      this.server.listen(this.opts.port, "127.0.0.1", () => resolvePromise());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolvePromise) => {
      if (!this.server) return resolvePromise();
      this.server.close(() => resolvePromise());
      this.server = undefined;
    });
  }
}

const DASHBOARD_HTML = /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Scribe Operator Console</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 24px; background: #f5f6f8; color: #1c2733; }
  h1 { font-size: 20px; }
  .card { background: #fff; border: 1px solid #d8dee6; border-radius: 8px; padding: 16px; margin-bottom: 16px; max-width: 760px; }
  .card.pending { border-left: 4px solid #d97706; }
  .card.claimed { border-left: 4px solid #2563eb; }
  .card.resolved, .card.expired { border-left: 4px solid #9ca3af; opacity: .7; }
  .meta { font-size: 13px; color: #4b5563; margin: 4px 0; }
  .reason { font-weight: 600; margin: 8px 0; }
  img { max-width: 100%; border: 1px solid #d8dee6; border-radius: 4px; margin-top: 8px; }
  button { padding: 6px 14px; border-radius: 6px; border: 1px solid #2563eb; background: #2563eb; color: #fff; cursor: pointer; margin-right: 8px; }
  button.secondary { background: #fff; color: #2563eb; }
  input, select { padding: 6px; border: 1px solid #d8dee6; border-radius: 6px; margin-right: 8px; }
  .empty { color: #6b7280; }
  .badge { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #e5e7eb; margin-left: 8px; }
</style>
</head>
<body>
<h1>Scribe Operator Console</h1>
<p class="meta">The automation is paused while an intervention is open. Claim it to take control of the live
browser window on this machine; your actions are recorded to the audit trail. Resolve to hand control back.</p>
<div id="list"><p class="empty">Loading…</p></div>
<script>
const DISPOSITIONS = {
  assist: ["completed_step", "fixed_environment", "abort"],
  approval: ["approve_once", "deny", "abort"],
};
// Untrusted values (operator names, reasons, URLs) are entity-escaped for HTML
// contexts and NEVER interpolated into JavaScript: buttons carry data-* ids
// and a delegated listener reads them back via getAttribute.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
let LATEST = {};
async function refresh() {
  const res = await fetch("/api/interventions");
  const items = await res.json();
  LATEST = {};
  items.forEach(function (it) { LATEST[it.request.id] = it; });
  const el = document.getElementById("list");
  if (!items.length) { el.innerHTML = '<p class="empty">No interventions yet.</p>'; return; }
  el.innerHTML = items.map(function (it) {
    const r = it.request;
    const opts = (DISPOSITIONS[r.type] || []).map(function (d) { return '<option>' + d + '</option>'; }).join("");
    let actions = "";
    if (it.status === "pending") {
      actions = '<input id="op_' + esc(r.id) + '" placeholder="your name">' +
        '<button data-act="claim" data-id="' + esc(r.id) + '">Claim &amp; take control</button>';
    } else if (it.status === "claimed") {
      actions = '<select id="disp_' + esc(r.id) + '">' + opts + '</select>' +
        '<input id="note_' + esc(r.id) + '" placeholder="note (optional)">' +
        '<button data-act="resolve" data-id="' + esc(r.id) + '">Resolve &amp; hand back</button>';
    } else {
      actions = '<span class="meta">' + esc(it.resolution && it.resolution.disposition) +
        (it.resolution && it.resolution.operator ? " by " + esc(it.resolution.operator) : "") + '</span>';
    }
    return '<div class="card ' + esc(it.status) + '">' +
      '<div><strong>' + esc(r.type) + '</strong> — ' + esc(r.capabilityId) +
      '<span class="badge">' + esc(it.status) + '</span></div>' +
      '<div class="reason">' + esc(r.reason) + '</div>' +
      (r.stepId ? '<div class="meta">step ' + esc(r.stepId) + ': ' + esc(r.intent) + '</div>' : "") +
      '<div class="meta">url: ' + esc(r.currentUrl) + '</div>' +
      '<div class="meta">requested ' + esc(r.requestedAt) + ' · expires ' + esc(r.expiresAt) + '</div>' +
      (r.screenshotPath ? '<img src="/shot/' + encodeURIComponent(r.id) + '" alt="screenshot">' : "") +
      '<div style="margin-top:10px">' + actions + '</div></div>';
  }).join("");
}
document.getElementById("list").addEventListener("click", function (e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  if (btn.getAttribute("data-act") === "claim") claim(id);
  else resolveIt(id);
});
async function claim(id) {
  const op = document.getElementById("op_" + id).value.trim();
  if (!op) return alert("Enter your name first.");
  const res = await fetch("/api/interventions/" + encodeURIComponent(id) + "/claim", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operator: op }),
  });
  if (!res.ok) alert((await res.json()).error);
  refresh();
}
async function resolveIt(id) {
  const it = LATEST[id];
  const operator = it && it.claimedBy ? it.claimedBy : "";
  const disposition = document.getElementById("disp_" + id).value;
  const note = document.getElementById("note_" + id).value;
  const res = await fetch("/api/interventions/" + encodeURIComponent(id) + "/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disposition, operator, note }),
  });
  if (!res.ok) alert((await res.json()).error);
  refresh();
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
