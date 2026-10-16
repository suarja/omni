import type { AiFunctionId } from "./ai-gateway-ipc";

export type AiModelTier = "small" | "standard" | "agent";

// Keep free models manual-only until the benchmark proves their reliability for Auto.
export const AUTO_ALLOWS_FREE = false;

export const AI_MODEL_PREFERENCES: Readonly<Record<AiModelTier, readonly string[]>> = {
  small: ["claude-haiku-4-5", "gpt-5-mini", "llama3.2", "mistral-small"],
  standard: ["claude-sonnet-5", "gpt-5", "llama3.1", "mistral-large"],
  agent: ["claude-sonnet-5", "gpt-5", "llama3.1", "mistral-large"],
};

export const AGENT_MODEL_PREFERENCES: readonly string[] = AI_MODEL_PREFERENCES.agent;

export const AI_TASK_TIERS: Readonly<Record<AiFunctionId, AiModelTier>> = {
  "suggest-adapt": "standard",
  explain: "small",
  summarize: "small",
  compose: "agent",
};
