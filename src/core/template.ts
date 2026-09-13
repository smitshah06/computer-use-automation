// {{inputs.x}} / {{secrets.x}} / {{env.x}} templating. Resolution fails closed
// on unknown references. Parameterization is the inverse, applied by the
// Recorder so artifacts never persist literal (possibly sensitive) values.

export interface TemplateContext {
  inputs: Record<string, string>;
  secrets: Record<string, string>;
  env: Record<string, string>;
}

const REF_RE = /\{\{\s*(inputs|secrets|env)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function resolveTemplate(text: string, ctx: TemplateContext): string {
  return text.replace(REF_RE, (_m, scope: string, name: string) => {
    const table = ctx[scope as keyof TemplateContext];
    const v = table[name];
    if (v === undefined) {
      throw new Error(`unresolved template reference {{${scope}.${name}}}`);
    }
    return v;
  });
}

// Resolution variant for strings that will be compiled as regular expressions
// (urlMatches, valueMatches). The surrounding pattern is author-written regex;
// the substituted runtime values are data — escape them so an input like
// "12.5" or "(test)" can neither break compilation nor over/under-match.
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveTemplateInRegex(text: string, ctx: TemplateContext): string {
  return text.replace(REF_RE, (_m, scope: string, name: string) => {
    const table = ctx[scope as keyof TemplateContext];
    const v = table[name];
    if (v === undefined) {
      throw new Error(`unresolved template reference {{${scope}.${name}}}`);
    }
    return escapeRegExp(v);
  });
}

export function findUnresolved(text: string): string[] {
  const known = new Set<string>();
  for (const m of text.matchAll(REF_RE)) known.add(m[0]);
  const anyRef = /\{\{[^}]*\}\}/g;
  const out: string[] = [];
  for (const m of text.matchAll(anyRef)) {
    if (!known.has(m[0])) out.push(m[0]);
  }
  return out;
}

export function referencedSecrets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(REF_RE)) {
    if (m[1] === "secrets") out.push(m[2] as string);
  }
  return out;
}

// SCRIBE_SECRET_TELLER_USERNAME -> secrets.tellerUsername
export function loadSecretsFromEnv(env: NodeJS.ProcessEnv, prefixes: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    for (const prefix of prefixes) {
      if (k.startsWith(prefix)) {
        const parts = k.slice(prefix.length).toLowerCase().split("_").filter(Boolean);
        const name = parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join("");
        out[name] = v;
      }
    }
  }
  return out;
}

// Replace recorded literals with {{inputs.x}} references. Exact match first;
// then embedded occurrences of values long enough to be unambiguous.
export function parameterizeValue(literal: string, inputs: Record<string, string>): string {
  for (const [name, value] of Object.entries(inputs)) {
    if (literal === value) return `{{inputs.${name}}}`;
  }
  let out = literal;
  const byLength = Object.entries(inputs).sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of byLength) {
    if (value.length >= 4 && out.includes(value)) {
      out = out.split(value).join(`{{inputs.${name}}}`);
    }
  }
  return out;
}
