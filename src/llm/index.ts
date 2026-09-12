import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import type { LLMProvider } from "./types";

export * from "./types";
export { AnthropicProvider } from "./anthropic";
export { OpenAIProvider } from "./openai";

export function makeProvider(name: string, model?: string): LLMProvider {
  if (name === "anthropic") return new AnthropicProvider(model);
  if (name === "openai") return new OpenAIProvider(model);
  throw new Error(`unknown LLM provider "${name}" (expected "anthropic" or "openai")`);
}
