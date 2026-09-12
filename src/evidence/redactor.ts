// Central redaction: every string that leaves the system through logs,
// results, or intervention records passes through here. Secrets and sensitive
// input values are registered once and masked everywhere.
export class Redactor {
  private values = new Set<string>();

  constructor(private replacement = "***") {}

  register(value: string | undefined): void {
    if (value && value.length >= 3) this.values.add(value);
  }

  registerAll(values: Record<string, string>, sensitiveNames?: Set<string>): void {
    for (const [name, v] of Object.entries(values)) {
      if (!sensitiveNames || sensitiveNames.has(name)) this.register(v);
    }
  }

  mask(text: string): string {
    let out = text;
    for (const v of this.values) {
      if (out.includes(v)) out = out.split(v).join(this.replacement);
    }
    return out;
  }

  maskDeep<T>(value: T): T {
    if (typeof value === "string") return this.mask(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.maskDeep(v)) as unknown as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.maskDeep(v);
      return out as T;
    }
    return value;
  }
}
