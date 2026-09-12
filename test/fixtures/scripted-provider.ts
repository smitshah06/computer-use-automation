import type { AssistantDecision, DecideRequest, LLMProvider } from "../../src/llm";

// Deterministic stand-in for a real model: each entry consumes one decide()
// call and sees the latest observation (last user/tool turn content), so tests
// can pick element refs exactly the way a model would — proving the discovery
// loop, recorder and replay work end-to-end with no network and no API key.

export type ScriptedDecision = { toolName: string; toolInput: unknown; text?: string };
export type ScriptFn = (lastContent: string) => ScriptedDecision;

export class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  readonly model = "test-script";
  private i = 0;

  constructor(private readonly script: ScriptFn[]) {}

  async decide(req: DecideRequest): Promise<AssistantDecision> {
    let lastContent = "";
    for (let j = req.turns.length - 1; j >= 0; j -= 1) {
      const t = req.turns[j]!;
      if (t.role === "user" || t.role === "tool") {
        lastContent = t.content;
        break;
      }
    }
    const fn = this.script[this.i];
    if (!fn) throw new Error(`scripted provider exhausted after ${this.i} decisions`);
    this.i += 1;
    return { ...fn(lastContent), toolCallId: `call_${this.i}` };
  }
}

// Finds the ref of the first observation line whose "role \"name\" ..." tail
// matches the pattern, e.g. refOf(obs, /textbox "Teller ID"/).
export function refOf(observation: string, pattern: RegExp): string {
  for (const raw of observation.split("\n")) {
    const m = /^\[([A-Za-z0-9_]+)\]\s(.*)$/.exec(raw.trim());
    if (m && pattern.test(m[2]!)) return m[1]!;
  }
  throw new Error(`no element matching ${String(pattern)} in observation:\n${observation}`);
}
