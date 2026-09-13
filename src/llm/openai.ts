import OpenAI from "openai";
import type { AgentTurn, AssistantDecision, DecideRequest, LLMProvider } from "./types";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toMessages(system: string, turns: AgentTurn[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const t of turns) {
    if (t.role === "user") out.push({ role: "user", content: t.content });
    else if (t.role === "assistant") {
      out.push({
        role: "assistant",
        content: t.text ?? null,
        tool_calls: [
          {
            id: t.toolCallId,
            type: "function",
            function: { name: t.toolName, arguments: JSON.stringify(t.toolInput) },
          },
        ],
      });
    } else {
      out.push({ role: "tool", tool_call_id: t.toolCallId, content: t.content });
    }
  }
  return out;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly client: OpenAI;

  constructor(readonly model = process.env.SCRIBE_OPENAI_MODEL ?? "gpt-4o") {
    this.client = new OpenAI(); // reads OPENAI_API_KEY
  }

  async decide(req: DecideRequest): Promise<AssistantDecision> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: toMessages(req.system, req.turns),
      tools: req.tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      tool_choice: "required",
      // one decision per turn: the loop is observe -> decide -> act, and a
      // second tool call in the same response would be silently dropped
      parallel_tool_calls: false,
    });
    const msg = res.choices[0]?.message;
    const call = msg?.tool_calls?.[0];
    if (!call) throw new Error("openai: model returned no tool call");
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      throw new Error(`openai: tool call arguments are not valid JSON: ${call.function.arguments.slice(0, 200)}`);
    }
    return {
      text: msg?.content ?? undefined,
      toolName: call.function.name,
      toolInput: input,
      toolCallId: call.id,
      usage: { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens },
    };
  }
}
