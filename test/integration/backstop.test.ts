import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { PlaywrightDriver } from "../../src/surface/playwright-driver";
import { PolicyEngine, loadPolicyConfig } from "../../src/policy/engine";
import { Redactor } from "../../src/evidence/redactor";
import { RunLogger } from "../../src/evidence/run-logger";

// The act() chokepoint refuses to *initiate* off-allowlist navigation, but a
// page can initiate traffic by itself. These tests prove the network-layer
// backstop kills that traffic in-flight: exfiltration subresources, link
// navigations, and server-side redirect chains that leave the allowlist.

const APP_PORT = 4615;
const EVIL_PORT = 4616;
const APP = `http://127.0.0.1:${APP_PORT}`;
const EVIL = `http://127.0.0.1:${EVIL_PORT}`;

let appServer: Server;
let evilServer: Server;
const evilHits: string[] = [];
let driver: PlaywrightDriver;
let logger: RunLogger;

async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function blockedEvents(): Array<Record<string, unknown>> {
  const raw = readFileSync(join(logger.runDir, "run.jsonl"), "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.type === "net_blocked");
}

beforeAll(async () => {
  // Allowlisted fixture app whose PAGE tries to reach the evil origin.
  const app = express();
  app.get("/", (_req, res) => {
    res.send(`<!doctype html><html><head><title>Backstop Fixture</title></head><body>
      <h1>Backstop fixture</h1>
      <img src="${EVIL}/pixel.png" alt="tracker">
      <a id="exfil" href="${EVIL}/landing">read more</a>
    </body></html>`);
  });
  app.get("/redir", (_req, res) => res.redirect(302, `${EVIL}/landing`));
  appServer = app.listen(APP_PORT);

  // Off-allowlist origin that records every request that actually reaches it.
  const evil = express();
  evil.use((req, _res, next) => {
    evilHits.push(req.path);
    next();
  });
  evil.get("/pixel.png", (_req, res) => res.status(200).type("image/png").send(Buffer.alloc(8)));
  evil.get("/landing", (_req, res) => res.send("<html><body>exfiltrated</body></html>"));
  evilServer = evil.listen(EVIL_PORT);

  const config = loadPolicyConfig("policy.yaml");
  const policy = new PolicyEngine({ ...config, allowlist: { ...config.allowlist, origins: [APP] } });
  logger = new RunLogger("itest_backstop", new Redactor(), mkdtempSync(join(tmpdir(), "scribe-ev-")));
  driver = new PlaywrightDriver(policy, logger);
  await driver.launch();
});

afterAll(async () => {
  await driver.close();
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => evilServer.close(() => r()));
});

describe("network-layer origin backstop (context.route)", () => {
  it("aborts page-initiated subresource requests to off-allowlist origins in-flight", async () => {
    const nav = await driver.act({ kind: "navigate", url: `${APP}/`, risk: "safe", phase: "replay" });
    expect(nav.ok).toBe(true);

    // the <img> fetch is attempted by the page itself, then aborted
    expect(
      await until(() => blockedEvents().some((e) => e.origin === EVIL && e.resourceType === "image"))
    ).toBe(true);
    expect(evilHits).toHaveLength(0); // the request never left the browser
  });

  it("aborts a link navigation to an off-allowlist origin and fails closed afterwards", async () => {
    await driver.act({
      kind: "click",
      target: {
        strategies: [{ kind: "css", value: "#exfil" }],
        elementDescription: "link to the off-allowlist origin",
        framePath: [],
      },
      risk: "safe",
      phase: "replay",
    });

    expect(
      await until(() => blockedEvents().some((e) => e.origin === EVIL && e.navigation === true))
    ).toBe(true);
    expect(evilHits).toHaveLength(0);
    // Chromium parks the aborted navigation on its own error page — what
    // matters is that we never landed on the evil origin...
    expect(driver.url().startsWith(EVIL)).toBe(false);
    // ...and that the run fails CLOSED from here: the current URL is no longer
    // allowlisted, so the policy chokepoint refuses the next action outright.
    const next = await driver.act({ kind: "press", key: "Enter", risk: "safe", phase: "replay" });
    expect(next.ok).toBe(false);
    expect(next.denied).toMatch(/not allowlisted/);
  });

  it("recovers onto allowlisted pages: same-origin traffic is untouched", async () => {
    const nav = await driver.act({ kind: "navigate", url: `${APP}/`, risk: "safe", phase: "replay" });
    expect(nav.ok).toBe(true);
    expect(await driver.title()).toBe("Backstop Fixture");
  });

  it("vets a server 302 at its source: an off-allowlist Location never gets followed", async () => {
    // Playwright routes are never re-invoked for redirect-chain hops, so the
    // backstop replaces the 302 with a blocking response instead of letting
    // the browser follow it.
    const res = await driver.act({ kind: "navigate", url: `${APP}/redir`, risk: "safe", phase: "replay" });
    expect(res.ok).toBe(true); // the blocking response is a normal (5xx) page load
    expect(driver.url()).toBe(`${APP}/redir`); // still on the allowlisted origin
    expect(evilHits).toHaveLength(0);
    expect(blockedEvents().some((e) => e.origin === EVIL && e.redirect === true)).toBe(true);
  });
});
