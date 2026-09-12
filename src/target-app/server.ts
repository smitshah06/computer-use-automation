// Mock credit-union back-office ("CU BackOffice"). Deliberately legacy-hostile
// markup: table layout, font tags, auto-generated ctl00_* ids, no test ids,
// labels present on some screens and absent on others. Fault injection makes
// every runtime state in the design plan reproducible on demand.
import express from "express";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

type Fault = "session-expiry" | "interstitial" | "slow" | "error500";
const FAULTS: Fault[] = ["session-expiry", "interstitial", "slow", "error500"];

interface Account { type: string; number: string; balance: string }
interface Member {
  id: string; name: string; status: string; joined: string;
  restricted: boolean; accounts: Account[];
}
interface Seed {
  tellers: { username: string; password: string; name: string }[];
  members: Member[];
}

export function createTargetApp() {
  const seed: Seed = JSON.parse(readFileSync(join(HERE, "seed.json"), "utf8"));
  const sessions = new Map<string, { user: string }>();
  const armed = new Set<Fault>();
  let confirmSeq = 4180;

  const app = express();
  app.set("view engine", "ejs");
  app.set("views", join(HERE, "views"));
  app.use(express.urlencoded({ extended: false }));

  // --- fault-injection control (ops tooling, not part of the business UI) ---
  app.get("/__faults", (req, res) => {
    if (req.query.clear !== undefined) armed.clear();
    const arm = req.query.arm;
    if (typeof arm === "string") {
      if (!FAULTS.includes(arm as Fault)) {
        res.status(400).json({ error: `unknown fault ${arm}`, known: FAULTS });
        return;
      }
      armed.add(arm as Fault);
    }
    res.json({ armed: [...armed] });
  });

  const cookieToken = (req: express.Request): string | undefined =>
    req.headers.cookie?.split(";").map((c) => c.trim()).find((c) => c.startsWith("cusess="))?.slice("cusess=".length);

  // --- auth + faults for protected screens ---
  const protectedArea: express.RequestHandler = (req, res, next) => {
    if (armed.has("error500")) {
      armed.delete("error500");
      res.status(500).render("error500");
      return;
    }
    if (armed.has("slow") && req.method === "GET") {
      armed.delete("slow");
      res.render("loading");
      return;
    }
    const token = cookieToken(req);
    const session = token ? sessions.get(token) : undefined;
    if (session && armed.has("session-expiry")) {
      armed.delete("session-expiry");
      if (token) sessions.delete(token);
      res.redirect("/login?expired=1");
      return;
    }
    if (!session) {
      res.redirect("/login");
      return;
    }
    res.locals.user = session.user;
    res.locals.notice = false;
    if (armed.has("interstitial")) {
      armed.delete("interstitial");
      res.locals.notice = true;
    }
    next();
  };

  // --- routes ---
  app.get("/", (_req, res) => res.redirect("/desk"));

  app.get("/login", (req, res) => {
    res.render("login", { expired: req.query.expired === "1", error: null });
  });

  app.post("/login", (req, res) => {
    const { user, pass } = req.body as { user?: string; pass?: string };
    const teller = seed.tellers.find((t) => t.username === user && t.password === pass);
    if (!teller) {
      res.status(401).render("login", { expired: false, error: "Invalid teller credentials." });
      return;
    }
    const token = randomBytes(16).toString("hex");
    sessions.set(token, { user: teller.name });
    res.setHeader("Set-Cookie", `cusess=${token}; Path=/; HttpOnly`);
    res.redirect("/desk");
  });

  app.get("/logout", (req, res) => {
    const token = cookieToken(req);
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", "cusess=; Path=/; Max-Age=0");
    res.redirect("/login");
  });

  app.get("/desk", protectedArea, (_req, res) => res.render("desk"));

  app.get("/members", protectedArea, (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : null;
    const results = q === null ? null : seed.members.filter((m) => m.id === q);
    res.render("members-search", { q, results });
  });

  app.get("/members/:id", protectedArea, (req, res) => {
    const member = seed.members.find((m) => m.id === req.params.id);
    if (!member) {
      res.status(404).render("notfound");
      return;
    }
    if (member.restricted) {
      res.status(403).render("restricted", { member });
      return;
    }
    res.render("member-detail", { member });
  });

  app.get("/members/:id/accounts/new", protectedArea, (req, res) => {
    const member = seed.members.find((m) => m.id === req.params.id);
    if (!member || member.restricted) {
      res.status(404).render("notfound");
      return;
    }
    res.render("account-new", { member, error: null, form: { type: "Savings", nick: "", dep: "" } });
  });

  app.post("/members/:id/accounts/new", protectedArea, (req, res) => {
    const member = seed.members.find((m) => m.id === req.params.id);
    if (!member || member.restricted) {
      res.status(404).render("notfound");
      return;
    }
    const form = {
      type: String((req.body as any).type ?? "Savings"),
      nick: String((req.body as any).nick ?? ""),
      dep: String((req.body as any).dep ?? ""),
    };
    const dep = Number(form.dep.replace(/[$,]/g, ""));
    if (!Number.isFinite(dep) || dep < 5) {
      res.status(400).render("account-new", {
        member, form, error: "Initial deposit must be at least $5.00.",
      });
      return;
    }
    const prefix = form.type === "Checking" ? "CK" : form.type === "Holiday Club" ? "HC" : "SV";
    const stem = member.accounts[0]?.number.split("-")[1] ?? "9000";
    const number = `${prefix}-${stem}-${String(member.accounts.length + 1).padStart(2, "0")}`;
    const balance = `$${dep.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
    member.accounts.push({ type: form.type, number, balance });
    confirmSeq += 1;
    const confirmation = `CU-2026-${confirmSeq}`;
    res.render("account-confirm", { member, account: { type: form.type, number, balance }, confirmation });
  });

  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.PORT ?? 4600);
  createTargetApp().listen(port, () => {
    console.log(`CU BackOffice (mock) listening on http://localhost:${port}`);
    console.log(`Teller sign-in: teller1 / Demo!Pass1`);
    console.log(`Fault injection: GET /__faults?arm=session-expiry|interstitial|slow|error500  (&clear=1)`);
  });
}
