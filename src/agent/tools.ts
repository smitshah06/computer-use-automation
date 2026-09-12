import { z } from "zod";
import type { ToolDef } from "../llm";

// The model's entire action surface: four tools, strict schemas, validated
// with Zod before anything touches the driver. Every action carries intent +
// reasoning, which the Recorder distills into the reviewable artifact.

export const ActToolSchema = z
  .object({
    kind: z.enum(["navigate", "click", "fill", "select", "press"]),
    ref: z.string().optional(),
    url: z.string().optional(),
    value: z.string().optional(),
    key: z.string().optional(),
    risk: z.enum(["safe", "risky"]),
    intent: z.string().min(3),
    reasoning: z.string().min(3),
  })
  .strict()
  .refine((a) => a.kind !== "navigate" || !!a.url, { message: "navigate requires url" })
  .refine((a) => a.kind === "navigate" || !!a.ref, { message: "click/fill/select/press require ref" })
  .refine((a) => !["fill", "select"].includes(a.kind) || a.value !== undefined, {
    message: "fill/select require value",
  })
  .refine((a) => a.kind !== "press" || !!a.key, { message: "press requires key" });
export type ActToolInput = z.infer<typeof ActToolSchema>;

export const ExtractToolSchema = z
  .object({
    ref: z.string(),
    outputName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    type: z.enum(["string", "number", "money", "date"]).default("string"),
    sensitive: z.boolean().default(false),
    extractPattern: z.string().optional(),
    intent: z.string().min(3),
    reasoning: z.string().min(3),
  })
  .strict();
export type ExtractToolInput = z.infer<typeof ExtractToolSchema>;

export const DeclareOutcomeSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    description: z.string().min(3),
    detectorText: z.string().min(3),
    reasoning: z.string().min(3),
  })
  .strict();
export type DeclareOutcomeInput = z.infer<typeof DeclareOutcomeSchema>;

export const FinishToolSchema = z
  .object({
    status: z.enum(["success", "stuck"]),
    summary: z.string().min(3),
    reasoning: z.string().min(3),
  })
  .strict();
export type FinishToolInput = z.infer<typeof FinishToolSchema>;

const str = { type: "string" } as const;

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: "act",
    description:
      "Perform one UI action. Use refs from the CURRENT observation only. " +
      "risk=risky for anything that creates or mutates business data; navigation, searches, sign-in and reads are safe.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["navigate", "click", "fill", "select", "press"] },
        ref: { ...str, description: "element ref from the current observation (required except navigate)" },
        url: { ...str, description: "navigate only: absolute URL" },
        value: {
          ...str,
          description:
            "fill/select: text to enter. For credentials use template refs like {{secrets.name}} — never literal secrets.",
        },
        key: { ...str, description: "press only: key name, e.g. Enter" },
        risk: { type: "string", enum: ["safe", "risky"] },
        intent: { ...str, description: "short human-readable purpose of this action" },
        reasoning: { ...str, description: "why this action now" },
      },
      required: ["kind", "risk", "intent", "reasoning"],
      additionalProperties: false,
    },
  },
  {
    name: "extract",
    description:
      "Read a value the goal asked for from an on-screen element (by ref) and store it as a named output.",
    inputSchema: {
      type: "object",
      properties: {
        ref: str,
        outputName: { ...str, description: "identifier for the output, e.g. savingsBalance" },
        type: { type: "string", enum: ["string", "number", "money", "date"] },
        sensitive: { type: "boolean", description: "true if the value must be masked in logs" },
        extractPattern: { ...str, description: "optional regex; capture group 1 (or whole match) is kept" },
        intent: str,
        reasoning: str,
      },
      required: ["ref", "outputName", "intent", "reasoning"],
      additionalProperties: false,
    },
  },
  {
    name: "declare_outcome",
    description:
      "The application reports a legitimate business result that ends the task (e.g. 'No records found'). " +
      "Declare it with the exact on-screen text that identifies it. This terminates the run as a business outcome, not an error.",
    inputSchema: {
      type: "object",
      properties: {
        code: { ...str, description: "UPPER_SNAKE_CASE outcome code, e.g. MEMBER_NOT_FOUND" },
        description: str,
        detectorText: { ...str, description: "exact text visible on screen that identifies this outcome" },
        reasoning: str,
      },
      required: ["code", "description", "detectorText", "reasoning"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description:
      "End the run: success once the goal is accomplished and all requested outputs are extracted; stuck if no progress is possible.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["success", "stuck"] },
        summary: str,
        reasoning: str,
      },
      required: ["status", "summary", "reasoning"],
      additionalProperties: false,
    },
  },
];
