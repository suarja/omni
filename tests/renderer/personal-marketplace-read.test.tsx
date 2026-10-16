// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/renderer/i18n";
import { MyMarketplaceSheet } from "../../src/renderer/canvas/MyMarketplaceSheet";
import { projectApi, projectSnapshot } from "./project-view-fixture";
import type { Observation } from "../../src/domain/project-source-registry";
import { tCount } from "../../src/renderer/i18n";
import { CanvasToastProvider } from "../../src/renderer/canvas/CanvasToast";
import { createFallbackWorkspaceSetup } from "../../src/renderer/canvas/setup/fallback-workspace-setup";
import { ProjectCaptureSheet } from "../../src/renderer/canvas/ProjectCaptureSheet";
import { projectId, skillRow } from "./project-view-fixture";

it("reads the personal source once when its sheet opens, even with a cached observation", async () => {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(container);
  const source = projectSnapshot.registry.sources.find((source) => source.ownership === "personal")!;
  const cached = projectSnapshot.roots.find((root) => root.entry.id === source.ref.id)!.evidence;
  if (cached.status !== "observed") throw new Error("Expected a cached source observation.");
  let complete!: (value: Observation) => void;
  const onObserveAdoptionSource = vi.fn(
    () =>
      new Promise<Observation>((resolve) => {
        complete = resolve;
      }),
  );
  const observeEntry = vi.fn();
  const canvas = {
    context: { kind: "workspace" as const },
    snapshot: projectSnapshot,
    api: projectApi(),
    onObserveAdoptionSource,
    onEnsureGrant: vi.fn(async () => "grant"),
    onRefresh: vi.fn(),
    onNavigate: vi.fn(),
    onNavigateDestination: vi.fn(),
    setup: {
      ...createFallbackWorkspaceSetup(projectSnapshot),
      commands: { ...createFallbackWorkspaceSetup(projectSnapshot).commands, observeEntry },
    },
  };
  // The sheet must use the source callback, rather than the workspace selection command.
  const render = () =>
    root.render(
      <I18nProvider initialLanguage="fr">
        <CanvasToastProvider>
          <MyMarketplaceSheet canvas={canvas} onClose={vi.fn()} onNewSkill={vi.fn()} onApplyingChange={vi.fn()} />
        </CanvasToastProvider>
      </I18nProvider>,
    );
  try {
    await act(async () => render());
    expect(onObserveAdoptionSource).toHaveBeenCalledTimes(1);
    expect(observeEntry).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Lecture de la marketplace…");
    expect(container.textContent).not.toContain("Plugins · 0");
    await act(async () =>
      complete({
        ...cached.observation,
        inventory: {
          ...cached.observation.inventory,
          marketplace: { name: "Personal", manifestPath: "omni.marketplace.json", visibility: "public" },
          gitScopes: [{ id: "git-root", relativeRoot: "root", dirty: true }],
          packages: [
            ...cached.observation.inventory.packages!,
            {
              id: "new-plugin",
              relativeRoot: "plugins/new-plugin",
              displayName: "New plugin",
              format: "omni",
              manifestPaths: [],
              artifactIds: [],
            },
          ],
        },
      }),
    );
    expect(container.textContent).toContain("Plugins · 3");
    expect(container.textContent).toContain("publique · modifications locales");
    expect(container.textContent).not.toContain("Lecture de la marketplace…");
    await act(async () => render());
    expect(onObserveAdoptionSource).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
  }
});

it.each(["en", "fr"] as const)("uses singular and plural skill counts throughout %s canvas and sheets", (language) => {
  for (const key of ["projectView.skillCount", "canvas.projectNote", "canvas.groupNote", "skillActions.skills"]) {
    expect(tCount(key, 1, {}, language)).toContain("1 skill");
    expect(tCount(key, 1, {}, language)).not.toContain("1 skills");
    expect(tCount(key, 0, {}, language)).toContain("0 skills");
    expect(tCount(key, 2, {}, language)).toContain("2 skills");
  }
});

it("hides cached plugin evidence when the marketplace read fails an identity check", async () => {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  const diagnostic = "The local response did not match the selected root.";
  const canvas = {
    context: { kind: "workspace" as const },
    snapshot: projectSnapshot,
    api: projectApi(),
    onEnsureGrant: vi.fn(async () => "grant"),
    onRefresh: vi.fn(),
    onNavigate: vi.fn(),
    onNavigateDestination: vi.fn(),
    onObserveAdoptionSource: vi.fn(async () => {
      throw new Error(diagnostic);
    }),
  };
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <CanvasToastProvider>
            <MyMarketplaceSheet canvas={canvas} onClose={vi.fn()} onNewSkill={vi.fn()} onApplyingChange={vi.fn()} />
          </CanvasToastProvider>
        </I18nProvider>,
      ),
    );
    expect(container.querySelector("[role=alert]")?.textContent).toBe(diagnostic);
    expect(container.textContent).not.toContain("Project skills");
    expect(container.textContent).not.toContain("Plugins · 0");
    expect(container.querySelector(".skill-rows")).toBeNull();
    expect(container.textContent).not.toContain("Tools");
  } finally {
    act(() => root.unmount());
  }
});

it("reads plugins when capture opens before a source observation and shows the loading row", async () => {
  const container = document.createElement("div");
  document.body.replaceChildren(container);
  const root = createRoot(container);
  const source = projectSnapshot.registry.sources.find(({ ownership }) => ownership === "personal")!;
  const evidence = projectSnapshot.roots.find(({ entry }) => entry.id === source.ref.id)!.evidence;
  if (evidence.status !== "observed") throw new Error("Expected source fixture evidence.");
  let complete!: (value: Observation) => void;
  const observe = vi.fn(
    () =>
      new Promise<Observation>((resolve) => {
        complete = resolve;
      }),
  );
  const canvas = {
    context: { kind: "entry" as const, entry: { kind: "project" as const, id: projectId } },
    snapshot: { ...projectSnapshot, roots: projectSnapshot.roots.filter(({ entry }) => entry.id !== source.ref.id) },
    api: projectApi(),
    onEnsureGrant: vi.fn(async () => "grant"),
    onRefresh: vi.fn(),
    onNavigate: vi.fn(),
    onNavigateDestination: vi.fn(),
    onObserveAdoptionSource: observe,
  };
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="fr">
          <ProjectCaptureSheet
            canvas={canvas}
            projectId={projectId}
            projectName="alpha"
            row={skillRow("local-tool", "project-only")}
            onClose={vi.fn()}
            onApplied={vi.fn()}
            onApplyingChange={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
    expect(observe).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".skill-plugin-picker [role=status]")?.textContent).toBe(
      "Lecture de la marketplace…",
    );
    expect(container.querySelector<HTMLInputElement>(".skill-plugin-pick input")?.disabled).toBe(true);
    await act(async () => complete(evidence.observation));
    expect(container.querySelector(".skill-plugin-picker [role=status]")).toBeNull();
    expect(container.querySelectorAll(".skill-plugin-pick input")).toHaveLength(3);
    expect(container.querySelector(".skill-plugin-picker")?.textContent).toContain("pstack");
    expect(observe).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
  }
});
