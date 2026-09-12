import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  PolicyConfigSchema,
  type PolicyConfig,
  type ActionRequest,
  type ArtifactPolicy,
} from "../core";

export type PolicyDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "require_approval"; reason: string };

export function loadPolicyConfig(path: string): PolicyConfig {
  return PolicyConfigSchema.parse(parseYaml(readFileSync(path, "utf8")));
}

// The PolicyEngine is called from INSIDE SurfaceDriver.act(), so neither the
// discovery loop nor the replay engine can act outside it. Deny by default:
// unknown origins and unlisted action kinds are refused regardless of caller.
export class PolicyEngine {
  private artifactPolicy?: ArtifactPolicy;
  private reviewStatus: "draft" | "approved" = "draft";

  constructor(readonly config: PolicyConfig) {}

  bindArtifact(policy: ArtifactPolicy, reviewStatus: "draft" | "approved"): void {
    this.artifactPolicy = policy;
    this.reviewStatus = reviewStatus;
  }

  private originAllowed(url: string): boolean {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return false;
    }
    const globalOk = this.config.allowlist.origins.some((o) => new URL(o).origin === origin);
    if (!globalOk) return false;
    if (this.artifactPolicy) {
      return this.artifactPolicy.requiredOrigins.some((o) => new URL(o).origin === origin);
    }
    return true;
  }

  checkAction(req: ActionRequest, currentUrl: string): PolicyDecision {
    if (!this.config.actionKinds.includes(req.kind)) {
      return { decision: "deny", reason: `action kind "${req.kind}" is not in the global allowlist` };
    }
    if (this.artifactPolicy && !this.artifactPolicy.allowedActionKinds.includes(req.kind)) {
      return { decision: "deny", reason: `action kind "${req.kind}" is not permitted by this capability's policy` };
    }
    const urlToCheck = req.kind === "navigate" ? (req.url ?? "") : currentUrl;
    if (!this.originAllowed(urlToCheck)) {
      return { decision: "deny", reason: `origin of ${urlToCheck || "<empty url>"} is not allowlisted (deny by default)` };
    }
    if (req.risk === "risky") {
      if (req.phase === "discovery" && this.config.risky.discoveryRequiresConfirmation) {
        return { decision: "require_approval", reason: "risky action during discovery requires human confirmation" };
      }
      if (req.phase === "replay" || req.phase === "recovery") {
        const approved = this.reviewStatus === "approved";
        const unattendedOk = this.artifactPolicy?.unattendedReplay ?? false;
        if (this.config.risky.unattendedRequiresApprovedArtifact && (!approved || !unattendedOk)) {
          return {
            decision: "require_approval",
            reason: !approved
              ? "risky action in replay of a non-approved (draft) artifact"
              : "capability policy forbids unattended risky actions",
          };
        }
      }
    }
    return { decision: "allow" };
  }
}
