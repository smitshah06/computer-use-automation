import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "dist", "evidence", "artifacts", "docs", "scripts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["src/replay/**/*.ts"],
    rules: {
      // Belt-and-braces with scripts/depcheck.mjs: replay must stay LLM-free.
      "no-restricted-imports": ["error", { patterns: ["*llm*", "@anthropic-ai/*", "openai*"] }],
    },
  }
);
