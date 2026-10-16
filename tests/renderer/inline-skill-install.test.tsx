// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanvasRailProvider } from "../../src/renderer/canvas/rail/rail-context";
import { InlineSkillInstall } from "../../src/renderer/canvas/pages/InlineSkillInstall";
import { I18nProvider } from "../../src/renderer/i18n";
import { projectSnapshot } from "./project-view-fixture";
import { createFixture } from "./external-library-fixture";
import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));

it.each(["installed", "archived", "unavailable", "removed", "disabled"])(
  "drops a selected project that becomes %s before installation",
  async (change) => {
    const { api } = createFixture();
    const onInstall = vi.fn();
    let snapshot: ResourceSnapshot = structuredClone(projectSnapshot);
    async function render(installed: readonly string[] = [], disabled = false): Promise<void> {
      await act(async () =>
        root.render(
          <I18nProvider initialLanguage="en">
            <CanvasRailProvider
              canvas={{
                api,
                snapshot: { ...snapshot, registry: { ...snapshot.registry } },
                context: { kind: "workspace" },
                onEnsureGrant: vi.fn(async () => "grant"),
                onRefresh: vi.fn(),
                onNavigate: vi.fn(),
                onNavigateDestination: vi.fn(),
              }}
            >
              <InlineSkillInstall installedProjectIds={installed} disabled={disabled} onInstall={onInstall} />
            </CanvasRailProvider>
          </I18nProvider>,
        ),
      );
    }
    await render();
    for (const input of container.querySelectorAll<HTMLInputElement>("input")) await act(async () => input.click());
    const first = snapshot.registry.projects.find((project) => project.ref.id === "project-one")!;
    snapshot = {
      ...snapshot,
      registry: {
        ...snapshot.registry,
        projects: snapshot.registry.projects.flatMap((project) =>
          project !== first
            ? [project]
            : change === "removed"
              ? []
              : [
                  {
                    ...project,
                    ...(change === "archived" ? { archivedAt: "2026-10-12T12:00:00.000Z" } : {}),
                    ...(change === "unavailable" ? { availability: "missing" as const } : {}),
                  },
                ],
        ),
      },
    };
    await render(change === "installed" ? [first.ref.id] : [], change === "disabled");
    const install = container.querySelector<HTMLButtonElement>("button")!;
    expect(install.textContent).not.toContain("Project One");
    await act(async () => install.click());
    if (change === "disabled") expect(onInstall).not.toHaveBeenCalled();
    else expect(onInstall).toHaveBeenCalledWith(["project-two"]);
    expect(api.readProjectSkills).not.toHaveBeenCalled();
    // Eligibility returning later must not silently restore an old selection.
    snapshot = projectSnapshot;
    await render();
    const target = container.querySelector<HTMLInputElement>('[data-project-id="project-one"] input');
    if (target && change !== "installed") expect(target.checked).toBe(false);
  },
);
