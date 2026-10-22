// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import { projectApi, projectSnapshot } from "./project-view-fixture";
import type { WorkshopDeliveryStatus } from "../../src/shared/workshop-delivery-ipc";
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.replaceChildren();
});
it("shows project conflicts and updates on the workspace and opens the existing project surface", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const project = projectSnapshot.registry.projects[0]!,
    source = projectSnapshot.registry.sources[0]!;
  const status: WorkshopDeliveryStatus = {
    status: "ready",
    workshop: { sourceId: source.ref.id, name: source.displayName, sync: { status: "ahead", ahead: 2, behind: 0 } },
    plugins: { status: "ready", behind: 0, installations: [], diagnostics: [] },
    projects: [{ projectId: project.ref.id, conflicts: 2, updates: 2, unavailable: 0 }],
    diagnostics: [],
  };
  const onNavigate = vi.fn(),
    api = { ...projectApi(), getWorkshopDelivery: vi.fn(async () => status) };
  await act(async () =>
    root!.render(
      <I18nProvider initialLanguage="en">
        <ResourceCanvas
          context={{ kind: "workspace" }}
          api={api}
          snapshot={projectSnapshot}
          onEnsureGrant={async () => null}
          onRefresh={vi.fn()}
          onNavigate={onNavigate}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  expect(node.querySelector(`[data-testid="project-conflicts-${project.ref.id}"]`)?.textContent).toBe("2 conflicts");
  expect(node.querySelector(`[data-testid="project-updates-${project.ref.id}"]`)?.textContent).toBe("2 updates");
  expect(node.querySelector('[data-testid="workspace-delivery-status"]')?.textContent).toContain(
    "1 project needs attention",
  );
  expect(node.querySelector('[data-testid="workshop-sync-chip"]')?.textContent).toBe("2 unpushed commits");
  await act(async () =>
    node.querySelector<HTMLButtonElement>(`[data-testid="canvas-entry-project-${project.ref.id}"]`)!.click(),
  );
  expect(onNavigate).toHaveBeenCalledWith(
    expect.objectContaining({
      screen: "resource-canvas",
      context: { kind: "entry", entry: project.ref },
      initialProjectSheet: "project",
    }),
  );
});
