import type { PresetId } from "../../../shared/ai-gateway-ipc";

export type Preset = Readonly<{
  id: PresetId;
  displayName: string;
  piProvider?: PresetId;
  openAiCompatible?: Readonly<{ defaultBaseUrl: string }>;
  keyPlaceholder: string;
  scope: "remote" | "local";
  keyRequired: boolean;
}>;

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    piProvider: "anthropic",
    keyPlaceholder: "sk-ant-…",
    scope: "remote",
    keyRequired: true,
  },
  openai: {
    id: "openai",
    displayName: "OpenAI",
    piProvider: "openai",
    keyPlaceholder: "sk-…",
    scope: "remote",
    keyRequired: true,
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    piProvider: "openrouter",
    keyPlaceholder: "sk-or-…",
    scope: "remote",
    keyRequired: true,
  },
  "vercel-ai-gateway": {
    id: "vercel-ai-gateway",
    displayName: "Vercel AI Gateway",
    piProvider: "vercel-ai-gateway",
    keyPlaceholder: "vck_…",
    scope: "remote",
    keyRequired: true,
  },
  groq: {
    id: "groq",
    displayName: "Groq",
    piProvider: "groq",
    keyPlaceholder: "gsk_…",
    scope: "remote",
    keyRequired: true,
  },
  mistral: {
    id: "mistral",
    displayName: "Mistral",
    piProvider: "mistral",
    keyPlaceholder: "…",
    scope: "remote",
    keyRequired: true,
  },
  ollama: {
    id: "ollama",
    displayName: "Ollama",
    openAiCompatible: { defaultBaseUrl: "http://localhost:11434/v1" },
    keyPlaceholder: "No key",
    scope: "local",
    keyRequired: false,
  },
  lmstudio: {
    id: "lmstudio",
    displayName: "LM Studio",
    openAiCompatible: { defaultBaseUrl: "http://localhost:1234/v1" },
    keyPlaceholder: "No key",
    scope: "local",
    keyRequired: false,
  },
  custom: {
    id: "custom",
    displayName: "Custom OpenAI-compatible",
    openAiCompatible: { defaultBaseUrl: "" },
    keyPlaceholder: "Optional",
    scope: "remote",
    keyRequired: false,
  },
};

export function presetFor(id: PresetId): Preset {
  return PRESETS[id];
}
