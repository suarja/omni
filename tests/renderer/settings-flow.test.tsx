// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { SettingsSections } from "../../src/renderer/settings/SettingsSections";
import { I18nProvider } from "../../src/renderer/i18n";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES } from "../../src/shared/settings-ipc";
import type { DesktopApi } from "../../src/shared/ipc";

type Rendered = Readonly<{ container: HTMLDivElement; root: Root }>;

function renderApp(): Rendered {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => {
    root.render(
      <ThemeProvider>
        <I18nProvider>
          <App />
        </I18nProvider>
      </ThemeProvider>,
    );
  });
  return { container, root };
}

describe("settings renderer flow", () => {
  let rendered: Rendered | undefined;
  let localStorageDescriptor: PropertyDescriptor | undefined;
  let actEnvironmentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      } satisfies Pick<Storage, "clear" | "getItem" | "setItem">,
    });
    document.body.replaceChildren();
    document.documentElement.dataset.theme = "light";
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => {
      rendered?.root.unmount();
    });
    rendered?.container.remove();
    rendered = undefined;
    delete window.omni;
    if (localStorageDescriptor) {
      Object.defineProperty(window, "localStorage", localStorageDescriptor);
    }
    localStorageDescriptor = undefined;
    if (actEnvironmentDescriptor) {
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironmentDescriptor);
    } else {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
    actEnvironmentDescriptor = undefined;
  });

  it("keeps canvas settings light and omits appearance controls", async () => {
    window.omni = {
      listRegistry: vi
        .fn()
        .mockResolvedValue({ status: "ready", registry: { revision: 1, projects: [], sources: [] } }),
    } as unknown as DesktopApi;
    rendered = renderApp();
    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>(".canvas-rail-button[aria-label='Settings']")?.click(),
    );
    expect(rendered.container.querySelector("[data-testid=canvas-settings-sheet]")).not.toBeNull();
    expect(rendered.container.querySelector("[data-testid=settings-theme-control]")).toBeNull();
    expect(rendered.container.textContent).not.toContain("Appearance");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("exposes only truthful controls and persists the selected language", async () => {
    window.omni = {
      listRegistry: vi
        .fn()
        .mockResolvedValue({ status: "ready", registry: { revision: 1, projects: [], sources: [] } }),
    } as unknown as DesktopApi;
    rendered = renderApp();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      rendered?.container.querySelector<HTMLButtonElement>(".canvas-rail-button[aria-label='Settings']")?.click();
    });

    expect(rendered.container.textContent).toContain("Language");
    expect(rendered.container.textContent).not.toContain("Review setup");
    expect(rendered.container.textContent).toContain("no telemetry");
    expect(rendered.container.querySelectorAll("[data-testid='settings-reconfigure']")).toHaveLength(0);

    const frenchOption = rendered.container.querySelector<HTMLButtonElement>(
      "[data-testid=settings-language-control] button:nth-child(1)",
    );
    expect(frenchOption).not.toBeNull();
    act(() => frenchOption?.click());

    expect(window.localStorage.getItem("omni.language")).toBe("fr");
    expect(rendered.container.textContent).toContain("Réglages");
  });

  it("shows agent approval rows and persists both approval choices", async () => {
    const setSettings = vi.fn().mockResolvedValue({
      schemaVersion: 8,
      git: { commitChanges: true },
      agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: { warnProjectIds: [] } },
      ai: DEFAULT_AI_SETTINGS,
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "auto" as const },
    });
    const api = {
      getSettings: vi.fn().mockResolvedValue({
        schemaVersion: 8,
        git: { commitChanges: true },
        agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: { warnProjectIds: [] } },
        ai: DEFAULT_AI_SETTINGS,
        features: DEFAULT_FEATURES,
        externalLibrary: { updates: "auto" as const },
      }),
      setSettings,
    } as unknown as DesktopApi;
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.append(container);
    rendered = { container, root };
    act(() =>
      root.render(
        <I18nProvider>
          <SettingsSections api={api} />
        </I18nProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });

    for (const label of ["Personal marketplace approval", "Projects approval"]) {
      expect(
        [...container.querySelectorAll(`[aria-label="${label}"] button`)].map((button) => button.textContent),
      ).toEqual(["In the conversation", "In Omni"]);
    }
    expect(container.textContent).not.toContain("from Home or Activity");
    expect(container.textContent).toContain("My marketplace");
    expect(container.textContent).toContain("In the conversation");
    expect(container.textContent).toContain("Omni always asks here when files would be deleted");
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Personal marketplace approval"] button:nth-child(2)')
        ?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Projects approval"] button:nth-child(1)')?.click();
    });
    expect(setSettings).toHaveBeenNthCalledWith(1, {
      commitChanges: true,
      agents: { approval: { personalMarketplace: "omni", projects: "omni" }, guard: { warnProjectIds: [] } },
      ai: DEFAULT_AI_SETTINGS,
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "auto" as const },
    });
    expect(setSettings).toHaveBeenNthCalledWith(2, {
      commitChanges: true,
      agents: { approval: { personalMarketplace: "omni", projects: "conversation" }, guard: { warnProjectIds: [] } },
      ai: DEFAULT_AI_SETTINGS,
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "auto" as const },
    });
  });
});
