// Mock credit-union back-office ("CU BackOffice"). Deliberately legacy-hostile
// markup: table layout, font tags, auto-generated ctl00_* ids, no test ids,
// labels present on some screens and absent on others. Fault injection makes
// every runtime state in the design plan reproducible on demand.
//
// The app is theme-parameterized to simulate the SAME vendor product deployed
// at two credit unions: "cu-backoffice" (Community One, the recorded tenant)
// and "cu-north" (CU North: different branding, colors, label vocabulary, and
// auto-generated ids — identical routes, forms, and business behavior). This
// is the multi-tenant target a TenantBinding overlay is demonstrated against.
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

// --- tenant themes -----------------------------------------------------------
// Everything that differs between the two deployments lives here: brand,
// palette, auto-generated element ids, and label vocabulary. Strings that a
// recorded artifact targets and that do NOT differ per tenant (e.g. "System
// Notice", "OK", "Accounts", the sub-account form labels, seeded data) are
// deliberately kept in the views, not in the theme.
export type TenantId = "cu-backoffice" | "cu-north";

interface Theme {
  brand: string;
  tagline: string;
  footerOrg: string;
  branch: string;
  c: { page: string; header: string; taglineFg: string; band: string; grid: string };
  id: {
    navDesk: string; navSearch: string; navReports: string; navOut: string;
    noticePnl: string; noticeOk: string;
    loginUser: string; loginPass: string; loginGo: string;
    srchNum: string; srchFind: string; srchNone: string; mbrGrid: string;
    detNum: string; detName: string; detStatus: string; detJoined: string; detNew: string; acctGrid: string;
    newType: string; newNick: string; newDep: string; newCreate: string; newErr: string;
    confNum: string; confType: string; confAcct: string; confBal: string;
  };
  s: {
    signInTitle: string; userLabel: string; passLabel: string; signInBtn: string; badCreds: string;
    deskTitle: string; navDesk: string; navSearch: string; navOut: string;
    searchTitle: string; numberLabel: string; findBtn: string; resultsTitle: string;
    noLabel: string; noneFound: string;
    profileTitle: string; sinceLabel: string; custWord: string;
  };
}

export const THEMES: Record<TenantId, Theme> = {
  "cu-backoffice": {
    brand: "CU BackOffice",
    tagline: "Core Teller System v3.8.14",
    footerOrg: "Community One Credit Union",
    branch: "Branch 014 (Main St)",
    c: { page: "#EDEFF2", header: "#16325C", taglineFg: "#B9C6D8", band: "#D6DEEA", grid: "#9AA7B8" },
    id: {
      navDesk: "ctl00_Nav_lnkDesk", navSearch: "ctl00_Nav_lnkSearch", navReports: "ctl00_Nav_lnkReports", navOut: "ctl00_Nav_lnkOut",
      noticePnl: "ctl00_Notice_pnl", noticeOk: "ctl00_Notice_btnOk",
      loginUser: "ctl00_LoginCtl_txtUser", loginPass: "ctl00_LoginCtl_txtPass", loginGo: "ctl00_LoginCtl_btnGo",
      srchNum: "ctl00_MbrSrch_txtNum", srchFind: "ctl00_MbrSrch_btnFind", srchNone: "ctl00_MbrSrch_lblNone", mbrGrid: "ctl00_MbrGrd",
      detNum: "ctl00_Det_lblNum", detName: "ctl00_Det_lblName", detStatus: "ctl00_Det_lblStatus", detJoined: "ctl00_Det_lblJoined", detNew: "ctl00_Det_lnkNew", acctGrid: "ctl00_AcctGrd",
      newType: "ctl00_NewAcct_ddlType", newNick: "ctl00_NewAcct_txtNick", newDep: "ctl00_NewAcct_txtDep", newCreate: "ctl00_NewAcct_btnCreate", newErr: "ctl00_NewAcct_lblErr",
      confNum: "ctl00_Conf_lblNum", confType: "ctl00_Conf_lblType", confAcct: "ctl00_Conf_lblAcct", confBal: "ctl00_Conf_lblBal",
    },
    s: {
      signInTitle: "Teller Sign-In", userLabel: "Teller ID", passLabel: "Passcode", signInBtn: "Sign In",
      badCreds: "Invalid teller credentials.",
      deskTitle: "Teller Desk", navDesk: "Teller Desk", navSearch: "Member Search", navOut: "Sign Out",
      searchTitle: "Member Search", numberLabel: "Member Number:", findBtn: "Search", resultsTitle: "Member Results",
      noLabel: "Member No", noneFound: "No records found.",
      profileTitle: "Member Profile", sinceLabel: "Member Since", custWord: "Member",
    },
  },
  "cu-north": {
    brand: "CU North TellerWorks",
    tagline: "Unified Branch Console v11.2",
    footerOrg: "CU North Federal Credit Union",
    branch: "Branch 03 (Lakeview)",
    c: { page: "#F1F4EF", header: "#1E4D2B", taglineFg: "#BFD3C4", band: "#DDE8DC", grid: "#94A895" },
    id: {
      navDesk: "tw_Nav_lnkDesk", navSearch: "tw_Nav_lnkFind", navReports: "tw_Nav_lnkRpt", navOut: "tw_Nav_lnkOut",
      noticePnl: "tw_Notice_pnl", noticeOk: "tw_Notice_btnOk",
      loginUser: "tw_LogOn_fldUser", loginPass: "tw_LogOn_fldPin", loginGo: "tw_LogOn_btnGo",
      srchNum: "tw_CustFind_fldNo", srchFind: "tw_CustFind_btnGo", srchNone: "tw_CustFind_lblNone", mbrGrid: "tw_CustGrid",
      detNum: "tw_Prof_lblNo", detName: "tw_Prof_lblName", detStatus: "tw_Prof_lblStatus", detJoined: "tw_Prof_lblSince", detNew: "tw_Prof_lnkNew", acctGrid: "tw_AcctGrid",
      newType: "tw_NewSub_ddlType", newNick: "tw_NewSub_txtNick", newDep: "tw_NewSub_txtDep", newCreate: "tw_NewSub_btnCreate", newErr: "tw_NewSub_lblErr",
      confNum: "tw_Conf_lblRef", confType: "tw_Conf_lblType", confAcct: "tw_Conf_lblAcct", confBal: "tw_Conf_lblBal",
    },
    s: {
      signInTitle: "Operator Log On", userLabel: "Operator ID", passLabel: "PIN", signInBtn: "Log On",
      badCreds: "Invalid operator credentials.",
      deskTitle: "Operator Desk", navDesk: "My Desk", navSearch: "Customer Search", navOut: "Log Off",
      searchTitle: "Customer Search", numberLabel: "Customer Number:", findBtn: "Find", resultsTitle: "Customer Results",
      noLabel: "Customer No", noneFound: "No matching customers on file.",
      profileTitle: "Customer Profile", sinceLabel: "Customer Since", custWord: "Customer",
    },
  },
};

export function createTargetApp(tenant: TenantId = "cu-backoffice") {
  const t = THEMES[tenant];
  const seed: Seed = JSON.parse(readFileSync(join(HERE, "seed.json"), "utf8"));
  const sessions = new Map<string, { user: string }>();
  const armed = new Set<Fault>();
  let confirmSeq = 4180;

  const app = express();
  app.set("view engine", "ejs");
  app.set("views", join(HERE, "views"));
  app.use(express.urlencoded({ extended: false }));
  app.locals.t = t; // theme is available to every view and partial

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
      res.status(401).render("login", { expired: false, error: t.s.badCreds });
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
  const tenant = (process.env.TENANT ?? "cu-backoffice") as TenantId;
  if (!(tenant in THEMES)) {
    console.error(`unknown TENANT "${tenant}" — known tenants: ${Object.keys(THEMES).join(", ")}`);
    process.exit(1);
  }
  // Loopback only: the mock back-office has fault-injection endpoints and
  // demo credentials — it must not be reachable from the network. Both
  // loopback families are bound so "localhost" works whichever way the
  // client's resolver orders ::1 / 127.0.0.1.
  const app = createTargetApp(tenant);
  app.listen(port, "127.0.0.1", () => {
    console.log(`${THEMES[tenant].brand} (mock, tenant ${tenant}) listening on http://localhost:${port}`);
    console.log(`Sign-in: teller1 / Demo!Pass1`);
    console.log(`Fault injection: GET /__faults?arm=session-expiry|interstitial|slow|error500  (&clear=1)`);
  });
  app.listen(port, "::1").on("error", () => {
    /* IPv6 loopback unavailable — IPv4 listener is enough */
  });
}
