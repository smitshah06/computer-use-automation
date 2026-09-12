import { randomBytes } from "node:crypto";

export function newRunId(prefix: "disc" | "replay"): string {
  return `${prefix}_${randomBytes(2).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "capability";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
