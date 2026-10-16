// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiCard } from "../../src/renderer/settings/AiCard";
import { I18nProvider } from "../../src/renderer/i18n";
import type { DesktopApi } from "../../src/shared/ipc";
import { DEFAULT_AI_SETTINGS } from "../../src/shared/settings-ipc";

const presets = {
  presets: [
    { id: "anthropic", displayName: "Anthropic", keyPlaceholder: "sk-ant-…", scope: "remote", keyRequired: true },
    {
      id: "ollama",
      displayName: "Ollama",
      keyPlaceholder: "No key",
      scope: "local",
      keyRequired: false,
      defaultBaseUrl: "http://localhost:11434/v1",
    },
  ],
} as const;

const models = {
  models: [
    {
      id: "vendor/gpt-5-mini",
      name: "gpt-5-mini",
      provider: "openrouter",
      contextWindow: 200_000,
      maxTokens: 1_000,
      maxOutputTokens: 1_000,
      tools: true,
      structuredOutputs: true,
      free: false,
      pricingKnown: true,
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    },
    {
      id: "vendor/claude-sonnet-5",
      name: "claude-sonnet-5",
      provider: "openrouter",
      contextWindow: 200_000,
      maxTokens: 1_000,
      maxOutputTokens: 1_000,
      tools: true,
      structuredOutputs: true,
      free: false,
      pricingKnown: true,
      cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
    },
  ],
} as const;

function renderCard(
  language: "en" | "fr",
  api: Partial<DesktopApi>,
  intelligence = DEFAULT_AI_SETTINGS,
): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider initialLanguage={language}>
        <AiCard api={api as DesktopApi} intelligence={intelligence} onIntelligenceChange={vi.fn()} />
      </I18nProvider>,
    ),
  );
  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function baseApi(connection: Awaited<ReturnType<NonNullable<DesktopApi["getAiConnection"]>>>): Partial<DesktopApi> {
  return {
    getAiConnection: vi.fn().mockResolvedValue(connection),
    getAiUsage: vi.fn().mockResolvedValue({ calls: 12, inputTokens: 1_000, outputTokens: 234, costUsd: 1.5 }),
    listAiPresets: vi.fn().mockResolvedValue(presets),
    listAiModels: vi.fn().mockResolvedValue(models),
  };
}

describe("AiCard", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
  });

  it("renders the four IA surfaces and no segmented provider control without a connection", async () => {
    rendered = renderCard("fr", baseApi({ keyState: "none" }));
    await flush();
    expect(rendered.container.textContent).toContain("Connexion");
    expect(rendered.container.textContent).toContain("Aucune connexion");
    expect(rendered.container.textContent).toContain("Fonctions IA");
    expect(rendered.container.textContent).toContain("Données envoyées");
    expect(rendered.container.textContent).toContain("Utilisation ce mois-ci");
    expect(rendered.container.textContent).toContain("12 appels · ≈ 1,50 $ (estimation) · 1 234 tokens");
    expect(rendered.container.querySelector(".ui-segmented-control")).toBeNull();
  });

  it("shows an honest missing-key state for a remote connection", async () => {
    rendered = renderCard(
      "fr",
      baseApi({ connection: { preset: "anthropic", displayName: "Anthropic" }, keyState: "none", scope: "remote" }),
    );
    await flush();
    expect(rendered.container.textContent).toContain("Anthropic · Aucune clé");
    expect(rendered.container.textContent).toContain("Indisponible · Clé manquante");
  });

  it("resolves Auto with the shared tier preference and formats usage in English", async () => {
    rendered = renderCard(
      "en",
      baseApi({ connection: { preset: "openrouter", displayName: "OpenRouter" }, keyState: "set", scope: "remote" }),
    );
    await flush();
    expect(rendered.container.textContent).toContain("OpenRouter · Key saved");
    expect(rendered.container.textContent).toContain("Auto → claude-sonnet-5");
    expect(rendered.container.textContent).toContain("12 calls · ≈ $1.50 (estimate) · 1,234 tokens");
  });

  it("shows the local connection endpoint", async () => {
    rendered = renderCard(
      "fr",
      baseApi({
        connection: { preset: "ollama", displayName: "Ollama", baseUrl: "http://localhost:11434/v1" },
        keyState: "none",
        scope: "local",
      }),
    );
    await flush();
    expect(rendered.container.textContent).toContain("Ollama · local · http://localhost:11434/v1");
  });
});
