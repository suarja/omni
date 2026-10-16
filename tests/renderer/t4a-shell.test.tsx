// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AppShell } from "../../src/renderer/shell/AppShell";
import type { AppShellProps } from "../../src/renderer/shell/routes";
import type { Route } from "../../src/renderer/navigation";
import { I18nProvider } from "../../src/renderer/i18n";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import { FeaturesProvider } from "../../src/renderer/features";
import { DEFAULT_FEATURES } from "../../src/shared/settings-ipc";
import { agentRequestRoute } from "../../src/renderer/review/agent-requests";
import { routeTable } from "./t4a-route-table";
import { agentRequests } from "./t4a-agent-requests";
import type { DesktopApi } from "../../src/shared/ipc";
import { projectApi, projectId, projectSnapshot } from "./project-view-fixture";

function shellProps(route: Route): AppShellProps {
  const audit: AppShellProps["destinationAudit"] = {
    status: "idle",
    report: null,
    error: null,
    progress: { completed: 0, total: 0 },
    start: vi.fn(),
    cancel: vi.fn(),
    refresh: vi.fn(),
  };
  return {
    api: null,
    route,
    resourceSnapshot: projectSnapshot,
    registry: { status: "ready", registry: projectSnapshot.registry },
    mode: "light",
    destinationAudit: audit,
    destinationObservation: null,
    openedEntry: null,
    registryBusy: false,
    registryMutationBusy: false,
    registryError: null,
    onModeChange: vi.fn(),
    onNavigate: vi.fn(),
    onNavigateToRoute: vi.fn(),
    onReaudit: vi.fn(),
    onRefreshRegistry: vi.fn(async () => null),
    onRetry: vi.fn(),
  };
}

async function assertCanvasRoutes(routes: readonly Route[]): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const route of routes) {
      await act(async () =>
        root.render(
          <FeaturesProvider
            value={{
              features: {
                ...DEFAULT_FEATURES,
                learn: true,
                activityAgents: true,
                compose: true,
                publicCatalogue: true,
              },
              setFeatures: vi.fn(),
            }}
          >
            <ThemeProvider>
              <I18nProvider initialLanguage="fr">
                <AppShell {...shellProps(route)} />
              </I18nProvider>
            </ThemeProvider>
          </FeaturesProvider>,
        ),
      );
      expect(container.querySelector(".app-shell--canvas"), route.screen).not.toBeNull();
      expect(
        container.querySelector('[data-testid="resource-canvas"], [data-testid="project-canvas"]'),
        route.screen,
      ).not.toBeNull();
      expect(container.querySelector(".sidebar"), route.screen).toBeNull();
      if (route.screen.startsWith("operation-") || route.screen === "assignment" || route.screen === "add-to-project") {
        expect(container.querySelector('[data-testid="changes-workbench"]'), route.screen).not.toBeNull();
        expect(container.querySelector(".operation-page, .assignment-page"), route.screen).toBeNull();
      }
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

it("renders every retained screen in the canvas shell, including enabled deferred routes", async () => {
  await assertCanvasRoutes([...Object.values(routeTable), { screen: "library", tab: "catalogue" }]);
});

it("opens every agent request kind inside the canvas shell", async () => {
  await assertCanvasRoutes(agentRequests.map(agentRequestRoute));
});

it("opens the add-skills sheet when a return link targets an already mounted project", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const api = projectApi() as unknown as DesktopApi;
  async function render(route: Route): Promise<void> {
    await act(async () =>
      root.render(
        <ThemeProvider>
          <I18nProvider initialLanguage="fr">
            <AppShell {...shellProps(route)} api={api} onEnsureGrant={async () => "grant"} />
          </I18nProvider>
        </ThemeProvider>,
      ),
    );
  }
  try {
    await render({ screen: "project", projectId, tab: "overview" });
    expect(container.querySelector('[data-testid="project-add-skills"]')).toBeNull();
    await render({ screen: "project-add", projectId });
    expect(container.querySelector('[data-testid="project-add-skills"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("restores a project receipt from the workbench and refreshes the affected project", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const receipt = {
    operationId: "apply-one",
    kind: "apply-plan" as const,
    status: "applied" as const,
    appliedAt: "2026-10-11T10:00:00Z",
    displayTarget: "Project",
    actions: [],
    git: { mode: "disabled" as const },
    registered: null,
    project: { id: projectId },
  };
  const api = {
    ...projectApi(),
    listOperations: vi.fn(async () => ({ status: "ready", receipts: [receipt] })),
    previewRestoreApply: vi.fn(async () => ({ status: "ready", planId: "restore-one", files: [] })),
    runRestoreApply: vi.fn(async () => ({ status: "applied", receipt: { ...receipt, kind: "restore-apply" } })),
  } as unknown as DesktopApi;
  const onProjectChanged = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ThemeProvider>
          <I18nProvider initialLanguage="fr">
            <AppShell
              {...shellProps({ screen: "operation-restore", operationId: "apply-one" })}
              api={api}
              onProjectChanged={onProjectChanged}
            />
          </I18nProvider>
        </ThemeProvider>,
      ),
    );
    expect(container.querySelector('[data-testid="changes-workbench"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="restore-apply"]')?.click());
    expect(api.runRestoreApply).toHaveBeenCalledWith({ planId: "restore-one" });
    expect(onProjectChanged).toHaveBeenCalledWith(projectId);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
