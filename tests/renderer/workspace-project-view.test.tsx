// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import type { ResourceSnapshot } from "../../src/domain/resource-catalogue";
import { projectApi, projectSnapshot, skills } from "./project-view-fixture";
import { resourceFixture } from "../fixtures/resource-catalogue";

let container: HTMLDivElement;
let root: Root;
const refresh = vi.fn();
const ensureGrant = vi.fn(async () => "grant");
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  refresh.mockClear();
  ensureGrant.mockClear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
function apiFor(snapshot: ResourceSnapshot) {
  return {
    ...projectApi(),
    readProjectSkills: vi.fn(async (id: string) => ({ ...skills, projectId: id })),
    observeSource: vi.fn(async () => ({ status: "observed" as const, observation: resourceFixture.sourceObservation })),
    archiveEntry: vi.fn(async (request: { kind: string; id: string; expectedRevision: number }) => ({
      status: "ready" as const,
      registry: {
        ...snapshot.registry,
        revision: request.expectedRevision + 1,
        projects: snapshot.registry.projects.filter((project) => project.ref.id !== request.id),
      },
    })),
  };
}
async function render(snapshot: ResourceSnapshot, api = apiFor(snapshot), language: "fr" | "en" = "fr") {
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage={language}>
        <ResourceCanvas
          context={{ kind: "workspace" }}
          api={api}
          snapshot={snapshot}
          onEnsureGrant={ensureGrant}
          onRefresh={refresh}
          onNavigate={vi.fn()}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  return api;
}
it("shows neutral counters for unobserved workspace roots without acquiring grants or reading them", async () => {
  const snapshot: ResourceSnapshot = {
    ...projectSnapshot,
    roots: projectSnapshot.roots.map((root) => ({ ...root, evidence: { status: "unobserved" } })),
  };
  const api = await render(snapshot);
  for (const title of ["Project One", "Personal Skills"]) {
    const node = [...container.querySelectorAll(".canvas-node-row")].find((node) => node.textContent?.includes(title))!;
    expect(node.querySelector(".canvas-node-meta")?.textContent).toBe("Pas encore lu");
    expect(node.querySelector(".canvas-node-meta.is-faint")).not.toBeNull();
    expect(node.querySelector('[data-glyph="project"], [data-glyph="marketplace"]')).not.toBeNull();
    expect(node.querySelector(".project-chip.is-update")).toBeNull();
  }
  expect(ensureGrant).not.toHaveBeenCalled();
  expect(api.readProjectSkills).not.toHaveBeenCalled();
  expect(api.observeSource).not.toHaveBeenCalled();
});
it("reuses observed skill counters across registry revisions without initiating a fresh read", async () => {
  const api = await render(projectSnapshot);
  await render({ ...projectSnapshot, registry: { ...projectSnapshot.registry, revision: 2 } }, api);
  for (const [title, count] of [
    ["Project One", "1 skill"],
    ["Personal Skills", "2 plugins · 2 skills · privée"],
  ]) {
    const node = [...container.querySelectorAll(".canvas-node-row")].find((node) => node.textContent?.includes(title))!;
    expect(node.querySelector(".canvas-node-meta")?.textContent).toBe(count);
  }
  expect(ensureGrant).not.toHaveBeenCalled();
  expect(api.readProjectSkills).not.toHaveBeenCalled();
  expect(api.observeSource).not.toHaveBeenCalled();
});
function withMissingProjects(): ResourceSnapshot {
  const projects = ["guard-scratch", "omni-v1-validation"].map((id) => ({
    ref: { kind: "project" as const, id },
    displayName: id,
    displayRoot: id,
    availability: "missing" as const,
  }));
  return {
    ...projectSnapshot,
    registry: { ...projectSnapshot.registry, projects: [...projectSnapshot.registry.projects, ...projects] },
    roots: [
      ...projectSnapshot.roots,
      ...projects.map((project) => ({
        entry: project.ref,
        evidence: { status: "unavailable" as const, reason: "missing" as const },
      })),
    ],
  };
}
it("groups missing projects and archives them with successive registry revisions", async () => {
  const api = await render(withMissingProjects());
  const button = [...container.querySelectorAll<HTMLButtonElement>(".canvas-node")].find((button) =>
    button.textContent?.includes("2 dossiers introuvables"),
  );
  expect(button).toBeDefined();
  expect(container.querySelectorAll(".canvas-node-row[data-missing-projects]")).toHaveLength(1);
  expect(api.readProjectSkills).not.toHaveBeenCalledWith("guard-scratch");
  await act(async () => button!.click());
  expect(container.querySelector("[data-testid=missing-projects-sheet]")?.textContent).toContain("guard-scratch");
  expect(api.archiveEntry).not.toHaveBeenCalled();
  const remove = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Retirer de l’espace",
  )!;
  await act(async () => remove.click());
  expect(api.archiveEntry.mock.calls).toEqual([
    [{ kind: "project", id: "guard-scratch", expectedRevision: 1 }],
    [{ kind: "project", id: "omni-v1-validation", expectedRevision: 2 }],
  ]);
  expect(refresh).toHaveBeenCalled();
});

it.each([
  ["en", "1 missing folder"],
  ["fr", "1 dossier introuvable"],
] as const)("uses the singular missing-folder label in %s nodes and sheets", async (language, label) => {
  const initial = withMissingProjects();
  const snapshot = {
    ...initial,
    registry: {
      ...initial.registry,
      projects: initial.registry.projects.filter((project) => project.ref.id !== "omni-v1-validation"),
    },
    roots: initial.roots.filter((root) => root.entry.id !== "omni-v1-validation"),
  };
  await render(snapshot, apiFor(snapshot), language);
  const button = container.querySelector<HTMLButtonElement>("[data-missing-projects] button");
  expect(button?.textContent).toContain(label);
  await act(async () => button!.click());
  expect(container.querySelector('[data-testid="missing-projects-sheet"] h2')?.textContent).toBe(label);
});

it("names only real observation problems in the workspace partial-observation heading", async () => {
  const snapshot: ResourceSnapshot = {
    ...projectSnapshot,
    roots: projectSnapshot.roots.map((root) =>
      root.evidence.status !== "observed"
        ? root
        : {
            ...root,
            evidence: {
              status: "observed",
              observation: {
                ...root.evidence.observation,
                inventory: {
                  ...root.evidence.observation.inventory,
                  diagnostics: [
                    { code: "git-unavailable", severity: "warning", location: ".git", message: "No Git repository." },
                    ...(root.entry.kind === "project"
                      ? [
                          {
                            code: "inaccessible" as const,
                            severity: "error" as const,
                            location: "skills/locked",
                            message: "Cannot read the folder.",
                          },
                        ]
                      : []),
                  ],
                },
              },
            },
          },
    ),
  };
  await render(snapshot, apiFor(snapshot), "en");
  const heading = container.querySelector(".canvas-stage-heading")?.textContent;
  expect(heading).toContain("Project One · skills/locked");
  expect(heading).not.toContain(".git");
  expect(heading).not.toContain("Personal Skills");
});
it("does not show an isolated root-unavailable heading on workspace", async () => {
  const initial = withMissingProjects();
  const snapshot: ResourceSnapshot = {
    ...initial,
    roots: initial.roots.map((root) => ({ ...root, evidence: { status: "unavailable", reason: "missing" } })),
  };
  await render(snapshot, apiFor(snapshot), "en");
  expect(container.querySelector(".canvas-stage-heading")?.textContent).not.toContain("This root is unavailable.");
});
it("reports an archive conflict without claiming that every missing project was removed", async () => {
  const snapshot = withMissingProjects();
  const api = apiFor(snapshot);
  api.archiveEntry.mockResolvedValue({ status: "revision-conflict", expected: 1, actual: 4 } as never);
  await render(snapshot, api);
  const group = [...container.querySelectorAll<HTMLButtonElement>(".canvas-node")].find((button) =>
    button.textContent?.includes("2 dossiers introuvables"),
  )!;
  expect(group).toBeDefined();
  await act(async () => group.click());
  const remove = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Retirer de l’espace",
  )!;
  await act(async () => remove.click());
  expect(api.archiveEntry).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[role=alert]")?.textContent).toContain("registre");
  expect(container.querySelector("[data-testid=missing-projects-sheet]")).not.toBeNull();
});
