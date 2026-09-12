// The provider seam. Discovery needs exactly one thing from a model: given the
// transcript so far and a set of tools, return the next tool call. Both the
// Anthropic and OpenAI adapters map this neutral shape onto their wire formats,
// and tests substitute a scripted provider — no network, same loop.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export type AgentTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; text?: string; toolName: string; toolInput: unknown; toolCallId: string }
  | { role: "tool"; toolCallId: string; content: string };

export interface AssistantDecision {
  text?: string; // model's visible reasoning, distilled into evidence
  toolName: string;
  toolInput: unknown;
  toolCallId: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface DecideRequest {
  system: string;
  turns: AgentTurn[];
  tools: ToolDef[];
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  decide(req: DecideRequest): Promise<AssistantDecision>;
}
