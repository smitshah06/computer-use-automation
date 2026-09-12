// Module dependency-boundary check. Fails the build when a module imports
// outside its allowed dependency list. Notably: replay/ has NO path to llm/,
// which makes "deterministic replay" a structural guarantee, not a convention.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";

const SRC = resolve(process.cwd(), "src");

const ALLOWED = {
  core: [],
  policy: ["core"],
  evidence: ["core"],
  llm: ["core"],
  surface: ["core", "policy", "evidence"],
  escalation: ["core", "surface", "evidence"],
  replay: ["core", "surface", "evidence", "policy", "escalation"], // no llm!
  agent: ["core", "surface", "llm", "evidence", "policy", "escalation"],
  "target-app": [],
  cli: ["core", "surface", "llm", "agent", "replay", "policy", "escalation", "evidence"],
};

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

function moduleOf(absPath) {
  const rel = relative(SRC, absPath);
  if (rel.startsWith("..")) return null;
  return rel.split(sep)[0].replace(/\.ts$/, "");
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

const violations = [];
for (const file of walk(SRC)) {
  const from = moduleOf(file);
  if (!from || !(from in ALLOWED)) continue;
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (!spec || !spec.startsWith(".")) continue; // external packages are not module boundaries
    const target = moduleOf(resolve(dirname(file), spec));
    if (!target || target === from) continue;
    if (!ALLOWED[from]?.includes(target)) {
      violations.push(`${relative(process.cwd(), file)}: module "${from}" may not import "${target}" (spec: ${spec})`);
    }
  }
}

if (violations.length) {
  console.error("Dependency boundary violations:\n" + violations.map((v) => "  - " + v).join("\n"));
  process.exit(1);
}
console.log("depcheck OK: all module boundaries respected (replay/ has no import path to llm/)");
