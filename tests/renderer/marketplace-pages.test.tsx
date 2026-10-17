// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import type { Route } from "../../src/renderer/navigation";
import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";
import { createFixture, click } from "./external-library-fixture";
import { projectSnapshot } from "./project-view-fixture";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
async function mount(
  options: {
    noProjects?: boolean;
    unavailable?: boolean;
    missingApi?: boolean;
    remote?: boolean;
    archivedProject?: boolean;
  } = {},
) {
  const fixture = createFixture();
  const api = {
    ...fixture.api,
    readWorkspaceSkillUses: options.missingApi
      ? undefined
      : vi.fn(async () =>
          options.unavailable
            ? { status: "unavailable" as const }
            : {
                status: "ready" as const,
                uses: [
                  {
                    skillId: "11111111-1111-4111-8111-111111111111",
                    bindingId: "binding-one",
                    baseRevisionId: "22222222-2222-4222-8222-222222222222",
                    source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" },
                    location: {
                      projectId: "project-one",
                      harnessId: "codex" as const,
                      folderPath: ".agents/skills/review",
                    },
                  },
                ],
              },
        ),
  };
  const snapshot: ResourceSnapshot = {
    ...projectSnapshot,
    registry: {
      ...projectSnapshot.registry,
      projects: options.noProjects
        ? []
        : projectSnapshot.registry.projects.map((project) =>
            options.archivedProject && project.ref.id === "project-one"
              ? { ...project, archivedAt: "2026-10-12T00:00:00.000Z" }
              : project,
          ),
    },
    roots: projectSnapshot.roots.map((root) =>
      root.entry.kind === "source" && root.evidence.status === "observed" && options.remote
        ? {
            ...root,
            evidence: {
              status: "observed",
              observation: {
                ...root.evidence.observation,
                inventory: {
                  ...root.evidence.observation.inventory,
                  marketplace: {
                    ...root.evidence.observation.inventory.marketplace!,
                    remotePackages: [
                      {
                        name: "remote-tools",
                        locator: "https://github.com/fixture/tools",
                        description: "Published elsewhere",
                      },
                    ],
                  },
                },
              },
            },
          }
        : root,
    ),
  };
  const grant = vi.fn(async () => "grant");
  function Parent() {
    const [route, navigate] = useState<Extract<Route, { screen: "resource-canvas" }>>({
      screen: "resource-canvas",
      context: { kind: "workspace" },
      canvasPage: { kind: "marketplace" },
    });
    return (
      <I18nProvider initialLanguage="en">
        <ResourceCanvas
          {...route}
          api={api}
          snapshot={snapshot}
          onEnsureGrant={grant}
          onNavigate={(next) => {
            if (next.screen === "resource-canvas") navigate(next);
          }}
          onRefresh={vi.fn()}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>
    );
  }
  await act(async () => root.render(<Parent />));
  return { api, grant };
}
it("shows project uses by exact source, plugin and skill path, including a separate same-name skill", async () => {
  const { api } = await mount();
  const used = container.querySelector('[data-page-section="pstack"]')!;
  const unused = container.querySelector('[data-page-section="other"]')!;
  expect(used.textContent).toContain("Project One");
  expect(unused.textContent).toContain("no project");
  await act(async () => used.querySelector<HTMLButtonElement>(".canvas-node")!.click());
  const sheet = container.querySelector('[data-testid="marketplace-skill-sheet"]')!;
  expect(sheet.textContent).toContain("Review source with evidence.");
  const installed = sheet.querySelector<HTMLInputElement>('[data-project-id="project-one"] input')!;
  expect(installed.disabled).toBe(true);
  expect(installed.checked).toBe(true);
  await act(async () => sheet.querySelector<HTMLInputElement>('[data-project-id="project-two"] input')!.click());
  await click(sheet, "Install in Project Two");
  expect(api.previewSkillOperation).toHaveBeenCalledWith({
    intent: {
      kind: "assign",
      sourceId: "source-one",
      packageId: "pstack",
      artifactPath: "skills/review",
      targets: [{ projectId: "project-two", harnessIds: ["claude-code", "codex"] }],
    },
  });
  expect(api.applySkillOperation).not.toHaveBeenCalled();
  expect(api.readProjectSkills).not.toHaveBeenCalled();
});
it("places remote GitHub plugins last and opens plugin management from their node", async () => {
  await mount({ remote: true });
  const sections = [...container.querySelectorAll("[data-page-section]")];
  expect(sections.at(-1)?.getAttribute("data-page-section")).toBe("remote");
  expect(sections.at(-1)?.textContent).toContain("Published elsewhere");
  await click(container, "remote-tools");
  expect(container.querySelector('[data-testid="my-marketplace-sheet"]')).not.toBeNull();
});
it("keeps a skill readable when the workspace has no project and exposes no install target", async () => {
  await mount({ noProjects: true });
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-page-section="other"] .canvas-node')!.click(),
  );
  const sheet = container.querySelector('[data-testid="marketplace-skill-sheet"]')!;
  expect(sheet.textContent).toContain("No project for now.");
  expect(sheet.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  expect(sheet.textContent).toContain("Read the entire skill");
});
it("excludes archived project bindings from marketplace chips and installed counts", async () => {
  await mount({ archivedProject: true });
  const used = container.querySelector('[data-page-section="pstack"]')!;
  expect(used.querySelectorAll(".project-chip.is-installed")).toHaveLength(0);
  await act(async () => used.querySelector<HTMLButtonElement>(".canvas-node")!.click());
  const sheet = container.querySelector('[data-testid="marketplace-skill-sheet"]')!;
  expect(sheet.querySelector("h3")?.textContent).toContain("Installed in · 0");
  expect(sheet.querySelector('[data-project-id="project-one"]')).toBeNull();
  expect(sheet.querySelector('[data-project-id="project-two"]')).not.toBeNull();
});
it("keeps installation disabled when project relationships cannot be read", async () => {
  await mount({ unavailable: true });
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-page-section="other"] .canvas-node')!.click(),
  );
  expect(container.querySelector('[data-testid="marketplace-skill-sheet"] [role="alert"]')).not.toBeNull();
  expect(container.querySelector<HTMLInputElement>('[data-project-id="project-two"] input')!.disabled).toBe(true);
});

it("does not offer installation without the workspace relationship API", async () => {
  await mount({ missingApi: true });
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-page-section="other"] .canvas-node')!.click(),
  );
  expect(container.querySelector<HTMLInputElement>('[data-project-id="project-two"] input')!.disabled).toBe(true);
});

it("spaces marketplace plugin sections according to the accepted grid", async () => {
  await mount();
  expect(container.querySelector<HTMLElement>('[data-page-section="pstack"] h3')!.style.top).toBe("70px");
  expect(container.querySelector<HTMLElement>('[data-page-section="other"] h3')!.style.top).toBe("216px");
});

it("uses the exact accepted marketplace header wording", async () => {
  await mount();
  const actions = container.querySelector(".page-head-actions")!;
  expect([...actions.querySelectorAll("button")].map((button) => button.textContent)).toContain("New skill");
  expect(actions.textContent).not.toContain("＋");
});

it("keeps the marketplace title and shows a named skeleton during its first observation", async () => {
  await mount();
  // Clear the cached observation to exercise an actual pending inventory read.
  const { api } = createFixture();
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="en">
        <ResourceCanvas
          api={api}
          snapshot={{ ...projectSnapshot, roots: [] }}
          context={{ kind: "workspace" }}
          canvasPage={{ kind: "marketplace" }}
          onEnsureGrant={async () => new Promise(() => {})}
          onRefresh={vi.fn()}
          onNavigate={vi.fn()}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  expect(container.querySelector(".stage-title")?.textContent).toContain("My marketplace");
  expect(container.querySelector("[data-testid=loading-skeleton]")?.getAttribute("aria-label")).toBe(
    "Loading My marketplace · Personal Skills",
  );
  expect(container.querySelector(".page-status")).toBeNull();
});
