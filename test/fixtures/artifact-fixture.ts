// Hand-authored capability artifact used by unit tests and (until discovery
// exists) by replay integration tests. Mirrors the PDF Appendix A example and
// targets the mock CU back-office in src/target-app.

export interface FixtureOptions {
  baseUrl?: string;
  sessionRecovery?: boolean; // include the session-expiry runSteps recovery
  unattendedReplay?: boolean;
  reviewStatus?: "draft" | "approved";
}

export function makeFixtureArtifact(opts: FixtureOptions = {}) {
  const base = opts.baseUrl ?? "http://localhost:4600";
  const origin = new URL(base).origin;
  const recoveries: any[] = [
    {
      id: "maintenance-interstitial",
      appliesTo: "global",
      detector: { elementVisible: { kind: "role", role: "dialog", name: "System Notice" } },
      action: {
        kind: "dismiss",
        target: {
          strategies: [
            { kind: "role", role: "button", name: "OK" },
            { kind: "css", value: "#ctl00_Notice_btnOk" },
          ],
          elementDescription: "OK button on the maintenance notice dialog",
          framePath: [],
        },
      },
      maxAttempts: 2,
    },
    {
      id: "transient-slow-load",
      appliesTo: "global",
      detector: { textPresent: "Loading, please wait" },
      action: { kind: "waitRetry", backoffMs: 2500 },
      maxAttempts: 3,
    },
  ];
  if (opts.sessionRecovery) {
    recoveries.push({
      id: "session-expiry-reauth",
      appliesTo: "global",
      detector: {
        any: [{ urlMatches: "/login\\?expired=1" }, { textPresent: "session has expired" }],
      },
      action: { kind: "runSteps", stepIds: ["s2", "s3", "s4"] },
      maxAttempts: 1,
    });
  }

  return {
    schemaVersion: "1.0",
    capability: {
      id: "member-savings-lookup",
      version: "1.0.0",
      name: "Member savings balance lookup",
      description: "Look up a member by member number and read their savings account balance.",
    },
    target: {
      appId: "cu-backoffice",
      surface: "web",
      entrypoint: `${base}/login`,
      appFingerprint: { titlePattern: "CU BackOffice", markers: ["Teller Sign-In"] },
    },
    inputs: [
      {
        name: "memberId",
        type: "string",
        required: true,
        pattern: "^\\d{5}$",
        sensitive: false,
        example: "12345",
        description: "Five-digit member number",
      },
    ],
    outputs: [
      { name: "savingsBalance", type: "money", sensitive: true, sourceStep: "s9" },
    ],
    steps: [
      {
        id: "s1",
        intent: "Open the teller sign-in page",
        action: "navigate",
        url: `${base}/login`,
        checkpoint: { all: [{ urlMatches: "/login" }, { textPresent: "Teller Sign-In" }] },
        risk: "safe",
        sensitive: false,
      },
      {
        id: "s2",
        intent: "Enter the teller username",
        action: "fill",
        target: {
          strategies: [
            { kind: "role", role: "textbox", name: "Teller ID" },
            { kind: "labelText", value: "Teller ID" },
            { kind: "nearText", value: "Teller ID" },
            { kind: "css", value: "#ctl00_LoginCtl_txtUser" },
          ],
          elementDescription: "Teller ID input in the sign-in panel",
          framePath: [],
        },
        value: "{{secrets.tellerUsername}}",
        sensitive: true,
        waitBefore: {
          condition: { elementVisible: { kind: "labelText", value: "Teller ID" } },
          timeoutMs: 5000,
        },
        risk: "safe",
      },
      {
        id: "s3",
        intent: "Enter the teller passcode",
        action: "fill",
        target: {
          strategies: [
            { kind: "role", role: "textbox", name: "Passcode" },
            { kind: "labelText", value: "Passcode" },
            { kind: "css", value: "#ctl00_LoginCtl_txtPass" },
          ],
          elementDescription: "Passcode input in the sign-in panel",
          framePath: [],
        },
        value: "{{secrets.tellerPassword}}",
        sensitive: true,
        risk: "safe",
      },
      {
        id: "s4",
        intent: "Submit the sign-in form",
        action: "click",
        target: {
          strategies: [
            { kind: "role", role: "button", name: "Sign In" },
            { kind: "css", value: "#ctl00_LoginCtl_btnGo" },
          ],
          elementDescription: "Sign In button",
          framePath: [],
        },
        checkpoint: { all: [{ urlMatches: "/desk" }, { textPresent: "Teller Desk" }] },
        risk: "safe",
        sensitive: false,
      },
      {
        id: "s5",
        intent: "Open the member search screen",
        action: "click",
        target: {
          strategies: [
            { kind: "role", role: "link", name: "Member Search" },
            { kind: "nearText", value: "Member Search" },
            { kind: "css", value: "#ctl00_Nav_lnkSearch" },
          ],
          elementDescription: "Member Search link in the desk navigation",
          framePath: [],
        },
        checkpoint: { all: [{ urlMatches: "/members" }, { textPresent: "Member Search" }] },
        risk: "safe",
        sensitive: false,
      },
      {
        id: "s6",
        intent: "Enter the member number to search for",
        action: "fill",
        target: {
          strategies: [
            { kind: "role", role: "textbox", name: "Member Number" },
            { kind: "labelText", value: "Member Number" },
            { kind: "nearText", value: "Member Number" },
            { kind: "css", value: "#ctl00_MbrSrch_txtNum" },
          ],
          elementDescription: "Member number input in the search panel",
          framePath: [],
        },
        value: "{{inputs.memberId}}",
        waitBefore: {
          condition: { textPresent: "Member Number" },
          timeoutMs: 5000,
        },
        risk: "safe",
        sensitive: false,
      },
      {
        id: "s7",
        intent: "Run the member search",
        action: "click",
        target: {
          strategies: [
            { kind: "role", role: "button", name: "Search" },
            { kind: "css", value: "#ctl00_MbrSrch_btnFind" },
          ],
          elementDescription: "Search button",
          framePath: [],
        },
        checkpoint: { textPresent: "Member Results" },
        risk: "safe",
        sensitive: false,
      },
      {
        id: "s8",
        intent: "Open the matching member's profile",
        action: "click",
        target: {
          strategies: [
            { kind: "nearText", value: "{{inputs.memberId}}" },
            { kind: "css", value: "#ctl00_MbrGrd_r0_c1 a" },
          ],
          elementDescription: "Member name link in the results row for the searched member number",
          framePath: [],
        },
        checkpoint: { all: [{ urlMatches: "/members/\\d+" }, { textPresent: "Member Profile" }] },
        risk: "safe",
        sensitive: false,
      },
      {
        id: "s9",
        intent: "Read the savings account balance",
        action: "extract",
        target: {
          strategies: [
            { kind: "nearText", value: "Savings" },
            { kind: "css", value: "#ctl00_AcctGrd_r0_c2" },
          ],
          elementDescription: "Balance cell of the Savings row in the Accounts table",
          framePath: [],
        },
        outputName: "savingsBalance",
        extractPattern: "\\$[\\d,]+\\.\\d{2}",
        risk: "safe",
        sensitive: false,
      },
    ],
    outcomes: [
      {
        code: "MEMBER_NOT_FOUND",
        terminal: true,
        description: "No member exists with the supplied member number.",
        detector: { all: [{ textPresent: "No records found" }] },
      },
      {
        code: "PERMISSION_DENIED",
        terminal: true,
        description: "The teller lacks access to this member record.",
        detector: { textPresent: "You do not have permission" },
      },
    ],
    recoveries,
    successCheckpoint: {
      all: [{ urlMatches: "/members/\\d+" }, { textPresent: "Accounts" }],
    },
    policy: {
      requiredOrigins: [origin],
      allowedActionKinds: ["navigate", "click", "fill", "extract"],
      riskLevel: "readonly",
      unattendedReplay: opts.unattendedReplay ?? true,
    },
    provenance: {
      provider: "fixture",
      model: "hand-authored",
      runId: "disc_fixture",
      recordedAt: "2026-09-10T18:20:11.000Z",
      evidenceRef: "evidence/disc_fixture/",
      reviewStatus: opts.reviewStatus ?? "approved",
    },
  };
}
