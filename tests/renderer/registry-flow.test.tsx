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
  status: "ready",
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
        artifacts: [
          {
            id: `${kind}-skill`,
            physicalIdentity: ".agents/skills/review/SKILL.md",
            projectionPaths: [".agents/skills/review/SKILL.md"],
            kind: "skill" as const,
            relativePath: ".agents/skills/review/SKILL.md",
            displayPath: ".agents/skills/review/SKILL.md",
            providerIds: ["codex"],
            scope: kind,
            confidence: "exact" as const,
            symlinkState: "none" as const,
          },
        ],
        diagnostics: [
          {
            location: "codex/AGENTS.md",
            code: "malformed" as const,
            severity: "warning" as const,
            message: "The documented metadata is malformed.",
          },
        ],
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
function openCanvasDestination(container: HTMLDivElement, _destination: "library" | "projects"): void {
  const workspace = container.querySelector<HTMLButtonElement>(".canvas-rail-button[aria-label='Home']");
  if (!workspace) throw new Error("Workspace canvas control is unavailable.");
  act(() => workspace.click());
}
async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
function deferred<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
describe("project and marketplace registry flow", () => {
  let rendered: Readonly<{ container: HTMLDivElement; root: Root }> | undefined;
  let actEnvironmentDescriptor: PropertyDescriptor | undefined;
  beforeEach(() => {
    actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.replaceChildren();
    document.documentElement.dataset.theme = "light";
  });
  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    delete window.omni;
    vi.restoreAllMocks();
    if (actEnvironmentDescriptor)
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironmentDescriptor);
    else delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    actEnvironmentDescriptor = undefined;
  });
  it("loads registered projects and opens the marketplace hierarchy", async () => {
    const api = createRegistryApi();
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "projects");
    await flushEffects();
    expect(api.listRegistry).toHaveBeenCalledTimes(1);
    expect(rendered?.container.textContent).toContain("Omni Project");
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-project-project-one']")?.click(),
    );
    await flushEffects();
    expect(api.openEntry).toHaveBeenCalledWith({ kind: "project", id: "project-one" });
    expect(api.observeProject).toHaveBeenCalledWith({ projectId: "project-one", grantHandle: "grant-entry" });
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
    expect(api.observeProject).toHaveBeenCalledTimes(1);
    act(() => rendered?.container.querySelector<HTMLButtonElement>(".canvas-breadcrumbs button:first-child")?.click());
    await flushEffects();
    openCanvasDestination(rendered!.container, "library");
    await flushEffects();
    expect(rendered?.container.textContent).toContain("Personal Skills");
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-source-source-one']")?.click(),
    );
    await flushEffects();
    expect(api.observeSource).toHaveBeenCalledWith({ sourceId: "source-one", grantHandle: "grant-entry" });
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
    expect(rendered?.container.textContent).toContain("Personal Skills");
  });
  it("opens a project-only profile directly in Workspace without a mandatory welcome", async () => {
    const api = createRegistryApi({
      listRegistry: vi.fn().mockResolvedValue({
        status: "ready",
        registry: { revision: 1, projects: [projectEntry], sources: [] },
      }),
    });
    rendered = renderApp(api);
    await flushEffects();
    expect(rendered?.container.querySelector(".sidebar")).toBeNull();
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
    expect(rendered?.container.textContent).toContain("Omni Project");
    expect(rendered?.container.querySelector("[data-testid='canvas-setup-menu-trigger']")).toBeTruthy();
    expect(rendered?.container.querySelector("[data-testid='onboarding-step-welcome']")).toBeNull();
  });
  it("shows the registered personal source as an unobserved workspace node", async () => {
    const api = createRegistryApi();
    rendered = renderApp(api);
    await flushEffects();
    const source = rendered?.container.querySelector("[data-testid='canvas-entry-source-source-one']");
    expect(source?.textContent).toContain("Personal Skills");
    expect(source?.getAttribute("data-state")).toBe("unobserved");
    expect(api.observeSource).not.toHaveBeenCalled();
  });

  it("labels a missing personal source without implying it was observed", async () => {
    const api = createRegistryApi({
      listRegistry: vi.fn().mockResolvedValue({
        status: "ready",
        registry: { ...registry.registry, sources: [{ ...sourceEntry, availability: "missing" }] },
      }),
    });
    rendered = renderApp(api);
    await flushEffects();
    const source = rendered?.container.querySelector("[data-testid='canvas-entry-source-source-one']");
    expect(source?.textContent).toContain("Personal Skills");
    expect(source?.getAttribute("aria-label")).toContain("unavailable");
    expect(api.observeSource).not.toHaveBeenCalled();
  });

  it("opens registered project evidence from the workspace node", async () => {
    const api = createRegistryApi();
    rendered = renderApp(api);
    await flushEffects();
    expect(rendered?.container.querySelector("[data-testid='canvas-entry-project-project-one']")).toBeTruthy();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-project-project-one']")?.click(),
    );
    await flushEffects();
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
    expect(api.observeProject).toHaveBeenCalledWith({ projectId: "project-one", grantHandle: "grant-entry" });
  });

  it("offers all three setup actions in an empty workspace", async () => {
    rendered = renderApp(
      createRegistryApi({
        listRegistry: vi
          .fn()
          .mockResolvedValue({ status: "ready", registry: { revision: 1, projects: [], sources: [] } }),
      }),
    );
    await flushEffects();
    for (const action of ["marketplace", "project", "agents"])
      expect(
        rendered?.container.querySelector(
          `[data-testid='workspace-setup-${action === "marketplace" ? "connect-marketplace" : action}']`,
        ),
      ).toBeTruthy();
    expect(rendered?.container.querySelector(".sidebar")).toBeNull();
    expect(rendered?.container.querySelector("[data-testid='onboarding-step-welcome']")).toBeNull();
  });

  it("keeps archive controls out of the B1 Library root", async () => {
    const api = createRegistryApi();
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "library");
    await flushEffects();
    const archive = rendered?.container.querySelector<HTMLButtonElement>("[data-testid='registry-archive-source-one']");
    expect(archive).toBeNull();
    expect(api.archiveEntry).not.toHaveBeenCalled();
  });
  it("rejects a mismatched opened entry without rendering its evidence", async () => {
    const api = createRegistryApi({
      openEntry: vi.fn().mockResolvedValue({ status: "granted", entry: projectEntry, grantHandle: "wrong-grant" }),
    });
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "library");
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-source-source-one']")?.click(),
    );
    await flushEffects();
    expect(api.observeSource).not.toHaveBeenCalled();
    expect(rendered?.container.textContent).toContain("The local response did not match the selected root");
    expect(rendered?.container.textContent).not.toContain("External source evidence");
  });
  it("rejects a mismatched observation without rendering active context", async () => {
    const api = createRegistryApi({
      observeSource: vi.fn().mockResolvedValue(observation("project")),
    });
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "library");
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-source-source-one']")?.click(),
    );
    await flushEffects();
    expect(rendered?.container.textContent).toContain("The local response did not match the selected root");
    expect(rendered?.container.textContent).not.toContain("External source evidence");
    expect(rendered?.container.textContent).not.toContain("Personal Skills\nRead-only scan");
  });
  it("preserves source ownership while the Library root exposes only hierarchy navigation", async () => {
    const archivedSource = { ...sourceEntry, archivedAt: "2026-09-09T11:00:00.000Z" };
    const archivedRegistry = {
      revision: 5,
      projects: [projectEntry],
      sources: [archivedSource],
    };
    const api = createRegistryApi({
      registerSource: vi.fn().mockResolvedValue({
        status: "ready",
        outcome: "created",
        entry: sourceEntry,
        grantHandle: "grant-source",
        registryRevision: 4,
      }),
      archiveEntry: vi.fn().mockResolvedValue({ status: "ready", registry: archivedRegistry }),
      reactivateEntry: vi.fn().mockResolvedValue({ status: "ready", registry: registry.registry }),
    });
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "library");
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-menu-trigger']")?.click(),
    );
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-add-marketplace']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-choice-external']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-connect-source']")?.click(),
    );
    expect(api.registerSource).toHaveBeenCalledWith({ ownership: "external" });
    await flushEffects();
    expect(rendered?.container.querySelector("[data-testid='canvas-entry-source-source-one']")).toBeTruthy();
    expect(rendered?.container.querySelector("[data-testid='registry-archive-source-one']")).toBeNull();
    expect(api.archiveEntry).not.toHaveBeenCalled();
    expect(api.reactivateEntry).not.toHaveBeenCalled();
  });
  it("refreshes the registered project and source registry", async () => {
    const listRegistry = vi.fn().mockResolvedValue(registry);
    const api = createRegistryApi({ listRegistry });
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "projects");
    await flushEffects();
    expect(listRegistry).toHaveBeenCalledTimes(1);
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[aria-label='Refresh']")?.click());
    await flushEffects();
    expect(listRegistry).toHaveBeenCalledTimes(2);
  });
  it("does not commit a selection attempted from stale rows during a deferred refresh", async () => {
    const refreshed = deferred<typeof registry>();
    const staleOpen = deferred<Awaited<ReturnType<DesktopApi["openEntry"]>>>();
    const listRegistry = vi.fn().mockResolvedValueOnce(registry).mockReturnValueOnce(refreshed.promise);
    const api = createRegistryApi({
      listRegistry,
      openEntry: vi.fn().mockReturnValue(staleOpen.promise),
    });
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "projects");
    await flushEffects();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[aria-label='Refresh']")?.click());
    const staleEntry = rendered?.container.querySelector<HTMLButtonElement>(
      "[data-testid='canvas-entry-project-project-one']",
    );
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
    act(() => staleEntry?.click());
    refreshed.resolve({ status: "ready", registry: { revision: 5, projects: [], sources: [] } });
    await flushEffects();
    staleOpen.resolve({ status: "granted", entry: projectEntry, grantHandle: "stale-grant" });
    await flushEffects();
    expect(api.openEntry).not.toHaveBeenCalled();
    expect(api.observeProject).not.toHaveBeenCalled();
    expect(rendered?.container.textContent).toContain("Create my marketplace");
  });
  it("does not commit an in-flight selection after a refresh replaces its registry generation", async () => {
    const refreshed = deferred<typeof registry>();
    const staleOpen = deferred<Awaited<ReturnType<DesktopApi["openEntry"]>>>();
    const listRegistry = vi.fn().mockResolvedValueOnce(registry).mockReturnValueOnce(refreshed.promise);
    const api = createRegistryApi({
      listRegistry,
      openEntry: vi.fn().mockReturnValue(staleOpen.promise),
    });
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "projects");
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-project-project-one']")?.click(),
    );
    expect(api.openEntry).toHaveBeenCalledTimes(1);
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
    openCanvasDestination(rendered!.container, "projects");
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[aria-label='Refresh']")?.click());
    expect(listRegistry).toHaveBeenCalledTimes(2);
    refreshed.resolve({ status: "ready", registry: { ...registry.registry, revision: 5 } });
    await flushEffects();
    staleOpen.resolve({ status: "granted", entry: projectEntry, grantHandle: "stale-grant" });
    await flushEffects();
    expect(api.observeProject).not.toHaveBeenCalled();
    expect(rendered?.container.textContent).not.toContain("Project inventory");
    expect(rendered?.container.textContent).toContain("Personal Skills");
  });
  it("keeps source selection controls bounded at the Library root", async () => {
    const api = createRegistryApi();
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "library");
    await flushEffects();
    expect(rendered?.container.querySelector("[data-testid='registry-archive-source-one']")).toBeNull();
    expect(rendered?.container.querySelector("[data-testid='registry-reactivate-source-one']")).toBeNull();
  });
  it("keeps the Library refresh action available independently of hierarchy navigation", async () => {
    const staleRefresh = deferred<typeof registry>();
    const listRegistry = vi.fn().mockResolvedValueOnce(registry).mockReturnValueOnce(staleRefresh.promise);
    const api = createRegistryApi({
      listRegistry,
    });
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "library");
    await flushEffects();
    const refresh = rendered?.container.querySelector<HTMLButtonElement>("[aria-label='Refresh']");
    act(() => refresh?.click());
    expect(listRegistry).toHaveBeenCalledTimes(2);
    expect(refresh).toBeTruthy();
    staleRefresh.resolve(registry);
    await flushEffects();
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")?.getAttribute("aria-busy")).toBe(
      "false",
    );
  });
  it("renders corruption as a bounded state instead of inventing a catalogue", async () => {
    const api = createRegistryApi({
      listRegistry: vi.fn().mockResolvedValue({
        status: "corrupt",
        diagnostic: "Registry JSON is invalid.",
        recoveryAvailable: true,
      }),
    });
    rendered = renderApp(api);
    await flushEffects();
    expect(rendered?.container.textContent).toContain("Registry unavailable");
    expect(rendered?.container.textContent).not.toContain("No catalogue items");
  });
  it("renders a bootstrap load failure and recovers on an explicit retry", async () => {
    const listRegistry = vi
      .fn()
      .mockRejectedValueOnce(new Error("Registry file could not be read."))
      .mockResolvedValueOnce(registry);
    const api = createRegistryApi({ listRegistry });
    rendered = renderApp(api);
    await flushEffects();
    expect(rendered?.container.textContent).toContain("Omni could not start");
    expect(rendered?.container.textContent).toContain("Registry file could not be read.");
    act(() => {
      [...(rendered?.container.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find((button) => button.textContent === "Retry")
        ?.click();
    });
    await flushEffects();
    expect(listRegistry).toHaveBeenCalledTimes(2);
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
  });
  it("clears prior evidence when a refresh reveals corruption", async () => {
    const listRegistry = vi
      .fn()
      .mockResolvedValueOnce(registry)
      .mockResolvedValueOnce({ status: "corrupt", diagnostic: "Registry JSON is invalid.", recoveryAvailable: true });
    const api = createRegistryApi({ listRegistry });
    rendered = renderApp(api);
    await flushEffects();
    openCanvasDestination(rendered!.container, "projects");
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-project-project-one']")?.click(),
    );
    await flushEffects();
    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
    openCanvasDestination(rendered!.container, "projects");
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[aria-label='Refresh']")?.click());
    await flushEffects();
    expect(rendered?.container.textContent).toContain("Registry unavailable");
    expect(rendered?.container.textContent).not.toContain("Raw observation");
  });
});
