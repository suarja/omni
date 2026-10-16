// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiConnectionSection } from "../../src/renderer/settings/AiConnectionSection";
import { I18nProvider } from "../../src/renderer/i18n";
import { FeaturesProvider } from "../../src/renderer/features";
import { DEFAULT_FEATURES } from "../../src/shared/settings-ipc";
import type { DesktopApi } from "../../src/shared/ipc";

const presets = {
  presets: [
    { id: "openrouter", displayName: "OpenRouter", keyPlaceholder: "sk-or-…", scope: "remote", keyRequired: true },
    {
      id: "ollama",
      displayName: "Ollama",
      keyPlaceholder: "No key",
      scope: "local",
      keyRequired: false,
      defaultBaseUrl: "http://localhost:11434/v1",
    },
    {
      id: "custom",
      displayName: "Custom OpenAI-compatible",
      keyPlaceholder: "Optional",
      scope: "remote",
      keyRequired: false,
    },
  ],
} as const;

const model = {
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
} as const;

const aiProvidersFeatures = { features: { ...DEFAULT_FEATURES, aiProviders: true }, setFeatures: () => undefined };

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
        <FeaturesProvider value={aiProvidersFeatures}>
          <AiConnectionSection api={api as DesktopApi} onNavigateToRoute={navigate} />
        </FeaturesProvider>
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

function inputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function connection(preset: "openrouter" | "ollama" | "custom", keyState: "set" | "none" = "none") {
  return {
    connection: {
      preset,
      displayName: preset === "openrouter" ? "OpenRouter" : preset === "ollama" ? "Ollama" : "Custom OpenAI-compatible",
      ...(preset === "ollama" ? { baseUrl: "http://localhost:11434/v1" } : {}),
      ...(preset === "custom" ? { baseUrl: "https://example.test/v1" } : {}),
    },
    keyState,
    scope: preset === "ollama" ? ("local" as const) : ("remote" as const),
  };
}

describe("AiConnectionSection", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
  });

  it("selects a preset and reveals its connection details", async () => {
    const setAiConnection = vi.fn().mockResolvedValue(connection("openrouter"));
    rendered = renderPage({
      listAiPresets: vi.fn().mockResolvedValue(presets),
      getAiConnection: vi.fn().mockResolvedValue({ keyState: "none" }),
      setAiConnection,
    });
    await flush();
    const row = Array.from(rendered.container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("OpenRouter"),
    );
    act(() => row?.click());
    await flush();
    expect(setAiConnection).toHaveBeenCalledWith({ preset: "openrouter" });
    expect(rendered.container.textContent).toContain("Fournisseur");
    expect(rendered.container.textContent).toContain("Clé");
  });

  it("saves and removes a key while keeping only its derived state", async () => {
    const getAiConnection = vi
      .fn()
      .mockResolvedValueOnce(connection("openrouter"))
      .mockResolvedValueOnce(connection("openrouter", "set"))
      .mockResolvedValueOnce(connection("openrouter"));
    const setAiKey = vi.fn().mockResolvedValue({ status: "ok" });
    const removeAiKey = vi.fn().mockResolvedValue({ status: "ok" });
    rendered = renderPage({
      listAiPresets: vi.fn().mockResolvedValue(presets),
      getAiConnection,
      setAiKey,
      removeAiKey,
    });
    await flush();
    const input = rendered.container.querySelector<HTMLInputElement>("[data-testid='settings-ai-key-input']");
    expect(input?.placeholder).toBe("sk-or-…");
    act(() => {
      if (input) inputValue(input, "sk-or-test");
    });
    act(() =>
      Array.from(rendered!.container.querySelectorAll("button"))
        .find((button) => button.textContent === "Enregistrer")
        ?.click(),
    );
    await flush();
    expect(setAiKey).toHaveBeenCalledWith({ key: "sk-or-test" });
    expect(rendered.container.textContent).toContain("Clé enregistrée");
    act(() =>
      Array.from(rendered!.container.querySelectorAll("button"))
        .find((button) => button.textContent === "Retirer")
        ?.click(),
    );
    await flush();
    expect(removeAiKey).toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Aucune clé");
  });

  it("renders reachable, unreachable, and missing-key tester answers", async () => {
    for (const result of [
      { status: "reachable" as const, models: [model] },
      { status: "unreachable" as const, reason: "refused" },
      { status: "key-missing" as const },
    ]) {
      const testAiConnection = vi.fn().mockResolvedValue(result);
      rendered = renderPage({
        listAiPresets: vi.fn().mockResolvedValue(presets),
        getAiConnection: vi.fn().mockResolvedValue(connection("openrouter")),
        testAiConnection,
      });
      await flush();
      act(() =>
        rendered?.container
          .querySelector("[data-testid='settings-ai-test']")
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      );
      await flush();
      expect(testAiConnection).toHaveBeenCalled();
      if (result.status === "reachable") expect(rendered?.container.textContent).toContain("claude-sonnet-5");
      if (result.status === "unreachable") expect(rendered?.container.textContent).toContain("Injoignable · refused");
      if (result.status === "key-missing") expect(rendered?.container.textContent).toContain("Clé manquante");
      act(() => rendered?.root.unmount());
      rendered?.container.remove();
      rendered = undefined;
    }
  });

  it("saves a custom base URL and confirms provider changes", async () => {
    const setAiConnection = vi.fn().mockResolvedValue(connection("custom"));
    const removeAiConnection = vi.fn().mockResolvedValue({ keyState: "none" });
    rendered = renderPage({
      listAiPresets: vi.fn().mockResolvedValue(presets),
      getAiConnection: vi.fn().mockResolvedValue(connection("custom")),
      setAiConnection,
      removeAiConnection,
    });
    await flush();
    const input = rendered.container.querySelector<HTMLInputElement>("[data-testid='settings-ai-base-url']");
    expect(input?.value).toBe("https://example.test/v1");
    act(() => {
      if (input) inputValue(input, "http://localhost:9000/v1");
    });
    act(() =>
      Array.from(rendered!.container.querySelectorAll("button"))
        .find((button) => button.textContent === "Enregistrer")
        ?.click(),
    );
    await flush();
    expect(setAiConnection).toHaveBeenCalledWith({ preset: "custom", baseUrl: "http://localhost:9000/v1" });
    act(() =>
      Array.from(rendered!.container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Changer de fournisseur"))
        ?.click(),
    );
    act(() =>
      Array.from(rendered!.container.querySelectorAll("button"))
        .find((button) => button.textContent === "Confirmer")
        ?.click(),
    );
    await flush();
    expect(removeAiConnection).toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("Choisir un fournisseur");
  });
});
