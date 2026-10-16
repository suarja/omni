// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { I18nProvider } from "../../src/renderer/i18n";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import type { DesktopApi } from "../../src/shared/ipc";

declare global {
  interface Window {
    omni?: DesktopApi;
  }
}

const projectEntry = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Omni Project",
  displayRoot: "acme-workspace",
  availability: "available" as const,
};
const sourceEntry = {
  ref: { kind: "source" as const, id: "source-one" },
  displayName: "Personal Skills",
  displayRoot: "personal-skills",
  availability: "available" as const,
  ownership: "personal" as const,
  capabilities: { observe: true as const, write: false as const },
};
const registry = {
  status: "ready" as const,
  registry: { revision: 4, projects: [projectEntry], sources: [sourceEntry] },
};

function observation(kind: "project" | "source") {
  return {
    status: "observed" as const,
    observation: {
      subject: { kind, id: kind === "project" ? "project-one" : "source-one" },
      observedAt: "2026-09-09T10:00:00.000Z",
      inventory: {
        rootHandle: "opaque-grant",
        displayRoot: kind === "project" ? "acme-workspace" : "personal-skills",
        observedAt: "2026-09-09T10:00:00.000Z",
        harnesses: ["codex", "cursor"],
        artifacts: [],
        diagnostics: [],
        gitScopes: [],
      },
    },
  };
}

function createRegistryApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    listRegistry: vi.fn().mockResolvedValue(registry),
    registerProject: vi.fn().mockResolvedValue({ status: "cancelled" }),
    registerSource: vi.fn().mockResolvedValue({ status: "cancelled" }),
    openEntry: vi.fn().mockImplementation((ref) =>
      Promise.resolve({
        status: "granted",
        entry: ref.kind === "project" ? projectEntry : sourceEntry,
        grantHandle: "grant-entry",
      }),
    ),
    observeProject: vi.fn().mockResolvedValue(observation("project")),
    observeSource: vi.fn().mockResolvedValue(observation("source")),
    archiveEntry: vi.fn().mockResolvedValue({ status: "ready", registry: registry.registry }),
    reactivateEntry: vi.fn().mockResolvedValue({ status: "ready", registry: registry.registry }),
    ...overrides,
  };
}

function renderApp(api: DesktopApi): Readonly<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  const root = createRoot(container);
  window.omni = api;
  document.body.append(container);
  act(() => {
    root.render(
      <ThemeProvider>
        <I18nProvider initialLanguage="en">
          <App />
        </I18nProvider>
      </ThemeProvider>,
    );
  });
  return { container, root };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function openWorkspace(container: HTMLDivElement): void {
  const workspace = container.querySelector<HTMLButtonElement>(".canvas-rail-button[aria-label='Home']");
  if (!workspace) throw new Error("Workspace canvas control is unavailable.");
  act(() => workspace.click());
}

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("registry concurrency safeguards", () => {
  let rendered: Readonly<{ container: HTMLDivElement; root: Root }> | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    document.documentElement.dataset.theme = "light";
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    delete window.omni;
    vi.restoreAllMocks();
  });

  it("preserves a corrupt open response as the bounded registry state", async () => {
    const api = createRegistryApi({
      openEntry: vi
        .fn()
        .mockResolvedValue({ status: "corrupt", diagnostic: "Registry payload is invalid.", recoveryAvailable: true }),
    });
    rendered = renderApp(api);
    await flushEffects();
    openWorkspace(rendered!.container);
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-source-source-one']")?.click(),
    );
    await flushEffects();

    expect(rendered?.container.textContent).toContain("Registry payload is invalid.");
    expect(rendered?.container.textContent).not.toContain("The local response did not match the selected root");
    expect(rendered?.container.querySelector(".shell-state--error")).toBeTruthy();
  });

  it("preserves a corrupt observation as the bounded registry state", async () => {
    const api = createRegistryApi({
      observeSource: vi.fn().mockResolvedValue({
        status: "corrupt",
        diagnostic: "Observed registry payload is invalid.",
        recoveryAvailable: true,
      }),
    });
    rendered = renderApp(api);
    await flushEffects();
    openWorkspace(rendered!.container);
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-source-source-one']")?.click(),
    );
    await flushEffects();

    expect(rendered?.container.textContent).toContain("Observed registry payload is invalid.");
    expect(rendered?.container.textContent).not.toContain("The local response did not match the selected root");
    expect(rendered?.container.querySelector(".shell-state--error")).toBeTruthy();
  });

  it("keeps mutation controls and refresh disabled while registration is deferred", async () => {
    const registration = deferred<Awaited<ReturnType<DesktopApi["registerSource"]>>>();
    const api = createRegistryApi({ registerSource: vi.fn().mockReturnValue(registration.promise) });
    rendered = renderApp(api);
    await flushEffects();
    openWorkspace(rendered!.container);
    await flushEffects();
    const refresh = rendered?.container.querySelector<HTMLButtonElement>("[aria-label='Refresh']");
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-menu-trigger']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-add-marketplace']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-choice-external']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-connect-source']")?.click(),
    );
    const confirm = rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-connect-source']");

    expect(confirm?.disabled).toBe(true);
    expect(refresh?.disabled).toBe(true);
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    registration.resolve({ status: "cancelled" });
    await flushEffects();
    expect(refresh?.disabled).toBe(false);
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")?.getAttribute("aria-busy")).toBe(
      "false",
    );
  });

  it("ignores external refresh during registration and accepts only its authorized post-refresh", async () => {
    const registration = deferred<Awaited<ReturnType<DesktopApi["registerSource"]>>>();
    const postRefresh = deferred<typeof registry>();
    const nextRegistry = { status: "ready" as const, registry: { ...registry.registry, revision: 5 } };
    const listRegistry = vi.fn().mockResolvedValueOnce(registry).mockReturnValueOnce(postRefresh.promise);
    const api = createRegistryApi({ listRegistry, registerSource: vi.fn().mockReturnValue(registration.promise) });
    rendered = renderApp(api);
    await flushEffects();
    openWorkspace(rendered!.container);
    await flushEffects();
    const refresh = rendered?.container.querySelector<HTMLButtonElement>("[aria-label='Refresh']");
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-menu-trigger']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-add-marketplace']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-choice-external']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-connect-source']")?.click(),
    );

    expect(refresh?.disabled).toBe(true);
    expect(listRegistry).toHaveBeenCalledTimes(1);
    act(() => refresh?.click());
    expect(listRegistry).toHaveBeenCalledTimes(1);
    registration.resolve({
      status: "ready",
      outcome: "created",
      entry: sourceEntry,
      grantHandle: "source-grant",
      registryRevision: 5,
    });
    await flushEffects();
    expect(listRegistry).toHaveBeenCalledTimes(2);
    postRefresh.resolve(nextRegistry);
    await flushEffects();

    expect(rendered?.container.textContent).toContain("Personal Skills");
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")?.getAttribute("aria-busy")).toBe(
      "false",
    );
  });

  it("blocks lifecycle mutations during registration and leaves the authorized registry authoritative", async () => {
    const registration = deferred<Awaited<ReturnType<DesktopApi["registerSource"]>>>();
    const postRefresh = deferred<typeof registry>();
    const nextRegistry = {
      status: "ready" as const,
      registry: { ...registry.registry, revision: 5, sources: [{ ...sourceEntry, displayName: "Registered Skills" }] },
    };
    const listRegistry = vi.fn().mockResolvedValueOnce(registry).mockReturnValueOnce(postRefresh.promise);
    const archiveEntry = vi.fn();
    const api = createRegistryApi({
      listRegistry,
      registerSource: vi.fn().mockReturnValue(registration.promise),
      archiveEntry,
    });
    rendered = renderApp(api);
    await flushEffects();
    openWorkspace(rendered!.container);
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-menu-trigger']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-add-marketplace']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-choice-external']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-connect-source']")?.click(),
    );
    act(() => rendered?.container.querySelector<HTMLElement>(".ui-breadcrumbs button")?.click());
    const activeArchive = rendered?.container.querySelector<HTMLButtonElement>(
      "[data-testid='registry-archive-source-one']",
    );

    expect(activeArchive).toBeNull();
    expect(archiveEntry).not.toHaveBeenCalled();
    registration.resolve({
      status: "ready",
      outcome: "created",
      entry: sourceEntry,
      grantHandle: "source-grant",
      registryRevision: 5,
    });
    await flushEffects();
    postRefresh.resolve(nextRegistry);
    await flushEffects();

    expect(rendered?.container.textContent).toContain("Registered Skills");
    expect(archiveEntry).not.toHaveBeenCalled();
  });

  it("reuses a fresh grant across canvas contexts and renews it after expiry", async () => {
    const api = createRegistryApi();
    rendered = renderApp(api);
    await flushEffects();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const open = (): void => {
      act(() =>
        rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-source-source-one']")?.click(),
      );
    };
    const workspace = (): void => {
      act(() =>
        rendered?.container.querySelector<HTMLButtonElement>(".canvas-breadcrumbs button:first-child")?.click(),
      );
    };
    open();
    await flushEffects();
    expect(api.openEntry).toHaveBeenCalledTimes(1);
    workspace();
    await flushEffects();
    open();
    await flushEffects();
    expect(api.openEntry).toHaveBeenCalledTimes(1);
    expect(api.observeSource).toHaveBeenCalledTimes(1);
    nowSpy.mockReturnValue(1_000_000 + 5 * 60 * 1000);
    workspace();
    await flushEffects();
    open();
    await flushEffects();
    expect(api.openEntry).toHaveBeenCalledTimes(2);
    expect(api.observeSource).toHaveBeenCalledTimes(2);
  });
});
