import Anthropic from "@anthropic-ai/sdk";
import type { AgentTurn, AssistantDecision, DecideRequest, LLMProvider } from "./types";

function toMessages(turns: AgentTurn[]): Anthropic.MessageParam[] {
  return turns.map((t): Anthropic.MessageParam => {
    if (t.role === "user") return { role: "user", content: t.content };
    if (t.role === "assistant") {
      const blocks: (Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam)[] = [];
      if (t.text) blocks.push({ type: "text", text: t.text });
      blocks.push({
        type: "tool_use",
        id: t.toolCallId,
        name: t.toolName,
        input: t.toolInput as Record<string, unknown>,
      });
      return { role: "assistant", content: blocks };
    }
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: t.toolCallId, content: t.content }],
    };
  });
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(readonly model = process.env.SCRIBE_ANTHROPIC_MODEL ?? "claude-sonnet-4-6") {
    this.client = new Anthropic(); // reads ANTHROPIC_API_KEY
  }

  async decide(req: DecideRequest): Promise<AssistantDecision> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1500,
      system: req.system,
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      })),
      tool_choice: { type: "any" }, // exactly one tool call per turn
      messages: toMessages(req.turns),
    });
    const text =
      res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n") || undefined;
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!call) throw new Error("anthropic: model returned no tool call");
    return {
      text,
      toolName: call.name,
      toolInput: call.input,
      toolCallId: call.id,
      usage: { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens },
    };
  }
}
