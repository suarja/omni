// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiFunctionSection } from "../../src/renderer/settings/AiFunctionSection";
import { I18nProvider } from "../../src/renderer/i18n";
import type { DesktopApi } from "../../src/shared/ipc";
import { DEFAULT_AI_SETTINGS } from "../../src/shared/settings-ipc";

const connection = {
  connection: { preset: "openrouter" as const, displayName: "OpenRouter" },
  keyState: "set" as const,
  scope: "remote" as const,
};
const models = {
  models: [
    {
      id: "claude-sonnet-5",
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

function renderPage(api: Partial<DesktopApi>): {
  container: HTMLDivElement;
  root: Root;
  navigate: ReturnType<typeof vi.fn>;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const navigate = vi.fn();
  act(() =>
    root.render(
      <I18nProvider initialLanguage="fr">
        <AiFunctionSection api={api as DesktopApi} onNavigateToRoute={navigate} task="suggest-adapt" />
      </I18nProvider>,
    ),
  );
  return { container, root, navigate };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AiFunctionSection", () => {
  let rendered: { container: HTMLDivElement; root: Root; navigate: ReturnType<typeof vi.fn> } | undefined;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
  });

  it("renders Auto and the listed models with context and price", async () => {
    rendered = renderPage({
      getAiConnection: vi.fn().mockResolvedValue(connection),
      listAiModels: vi.fn().mockResolvedValue(models),
      getSettings: vi.fn().mockResolvedValue({ ai: DEFAULT_AI_SETTINGS } as never),
    });
    await flush();
    expect(rendered.container.textContent).toContain("Auto");
    expect(rendered.container.textContent).toContain("claude-sonnet-5");
    expect(rendered.container.textContent).toContain("3 $ / 15 $ par M · 200 k · outils");
    expect(rendered.container.querySelector("[data-testid='settings-ai-function-auto']")?.className).toContain(
      "is-selected",
    );
  });

  it("saves a selected model and returns to Settings", async () => {
    const setAiFunctions = vi.fn().mockResolvedValue({
      functions: { ...DEFAULT_AI_SETTINGS.functions, "suggest-adapt": { modelId: "claude-sonnet-5" } },
    });
    rendered = renderPage({
      getAiConnection: vi.fn().mockResolvedValue(connection),
      listAiModels: vi.fn().mockResolvedValue(models),
      getSettings: vi.fn().mockResolvedValue({ ai: DEFAULT_AI_SETTINGS } as never),
      setAiFunctions,
    });
    await flush();
    act(() =>
      rendered?.container
        .querySelector("[data-testid='settings-ai-function-model-claude-sonnet-5']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();
    expect(setAiFunctions).toHaveBeenCalledWith({
      functions: { ...DEFAULT_AI_SETTINGS.functions, "suggest-adapt": { modelId: "claude-sonnet-5" } },
    });
    expect(rendered.navigate).toHaveBeenCalledWith({ screen: "settings" });
  });

  it("labels free models with their window and unknown tool support", async () => {
    rendered = renderPage({
      getAiConnection: vi.fn().mockResolvedValue(connection),
      listAiModels: vi.fn().mockResolvedValue({
        models: [
          {
            ...models.models[0],
            id: "vendor/model:free",
            name: "Free model",
            tools: "unknown",
            free: true,
            pricingKnown: true,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      }),
      getSettings: vi.fn().mockResolvedValue({ ai: DEFAULT_AI_SETTINGS } as never),
    });
    await flush();
    expect(rendered.container.textContent).toContain("gratuit · 200 k · outils ?");
  });

  it("saves Auto as an explicit choice", async () => {
    const current = {
      ...DEFAULT_AI_SETTINGS,
      functions: { ...DEFAULT_AI_SETTINGS.functions, "suggest-adapt": { modelId: "old-model" } },
    };
    const setAiFunctions = vi.fn().mockResolvedValue({ functions: DEFAULT_AI_SETTINGS.functions });
    rendered = renderPage({
      getAiConnection: vi.fn().mockResolvedValue(connection),
      listAiModels: vi.fn().mockResolvedValue(models),
      getSettings: vi.fn().mockResolvedValue({ ai: current } as never),
      setAiFunctions,
    });
    await flush();
    act(() =>
      rendered?.container
        .querySelector("[data-testid='settings-ai-function-auto']")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    await flush();
    expect(setAiFunctions).toHaveBeenCalledWith({ functions: { ...current.functions, "suggest-adapt": "auto" } });
  });
});
