// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import { projectApi, projectSnapshot } from "./project-view-fixture";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text || button.getAttribute("aria-label") === text,
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
async function render() {
  const api = {
    ...projectApi(),
    inspectProject: vi.fn(async () => ({
      status: "inspected",
      grantHandle: "picked-grant",
      displayName: "contenu",
      displayRoot: "contenu",
      inventory: {
        rootHandle: "picked-grant",
        displayRoot: "contenu",
        observedAt: "2026-10-12T00:00:00.000Z",
        harnesses: ["claude-code", "codex"],
        gitScopes: [{ id: "root", relativeRoot: ".", branch: "main", dirty: false }],
        artifacts: [],
        diagnostics: [],
      },
    })),
    inspectStorefront: vi.fn(async () => ({
      status: "ready",
      inspectionId: "inspected",
      displayName: "public-tools",
      isGitRepository: true,
      githubRepository: "fixture/public-tools",
      licenseFile: "LICENSE",
      plugins: [
        {
          pluginId: "demo",
          name: "demo",
          relativeRoot: "plugins/demo",
          manifestPaths: [],
          recognition: "not-from-your-marketplace",
        },
      ],
    })),
    linkStorefront: vi.fn(async () => ({
      status: "linked",
      sourceId: "storefront",
      inspection: { status: "ready", displayName: "public-tools", isGitRepository: true, plugins: [] },
      publications: [],
    })),
    readStorefrontCapabilities: vi.fn(async () => ({ gh: "unavailable" })),
    pickOperationParent: vi.fn(),
    previewOperation: vi.fn(),
    applyOperation: vi.fn(),
    getAgentStatus: vi.fn(async () => ({
      socketPath: "socket",
      tokenCreatedAt: "now",
      counts: { pending: 0, today: 0, total: 0 },
      harnesses: [],
    })),
  };
  const registerProject = vi.fn(async () => ({
    status: "ready",
    outcome: "created",
    entry: {
      ref: { kind: "project", id: "new-project" },
      displayName: "contenu",
      displayRoot: "contenu",
      availability: "available",
    },
    grantHandle: "registered-grant",
    registryRevision: 2,
  }));
  const registerSource = vi.fn(async () => ({ status: "cancelled" }));
  const setup = {
    api,
    snapshot: projectSnapshot,
    registryBusy: false,
    diagnostic: null,
    commands: { registerProject, registerSource, refreshRegistry: vi.fn(), observeEntry: vi.fn() },
  };
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="fr">
        <ResourceCanvas
          api={api as any}
          setup={setup as any}
          snapshot={projectSnapshot}
          context={{ kind: "workspace" }}
          onEnsureGrant={vi.fn(async () => "grant")}
          onRefresh={vi.fn()}
          onNavigate={vi.fn()}
          onNavigateDestination={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  await click("＋ Ajouter");
  return { api, registerProject, registerSource };
}
it("inspects before adding a project and Cancel leaves it unregistered", async () => {
  const { api, registerProject } = await render();
  await click("Projet");
  expect(document.activeElement?.textContent).toBe("Annuler");
  const submit = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Ajouter à l'espace",
  )!;
  expect(submit.disabled).toBe(true);
  await click("Choisir un dossier…");
  expect(api.inspectProject).toHaveBeenCalledTimes(1);
  expect(registerProject).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Ce qu'Omni a trouvé");
  expect(container.textContent).toContain("branche main · propre");
  expect(container.textContent).toContain("Omni lit ce dossier. Il n'y écrit rien en l'ajoutant.");
  await click("Annuler");
  expect(registerProject).not.toHaveBeenCalled();
});
it("adds the project using the inspected grant", async () => {
  const { registerProject } = await render();
  await click("Projet");
  await click("Choisir un dossier…");
  await click("Ajouter à l'espace");
  expect(registerProject).toHaveBeenCalledWith("picked-grant");
});
it("inspects a public storefront and leaves linking to the explicit Add action", async () => {
  const { api, registerSource } = await render();
  await click("Marketplace");
  expect(container.textContent).toContain("Source externe");
  expect(container.textContent).toContain("Vitrine publique");
  await click("Choisir un dossier…");
  expect(registerSource).toHaveBeenCalledWith("external");
  await click("Vitrine publique");
  await click("Choisir un dossier…");
  expect(api.inspectStorefront).toHaveBeenCalledTimes(1);
  expect(api.linkStorefront).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Ce qu'Omni a trouvé");
  expect(container.textContent).toContain("Omni lit ce dossier. Il n'y écrit rien en le reliant.");
  await click("Ajouter");
  expect(api.linkStorefront).toHaveBeenCalledWith({ inspectionId: "inspected" });
});
it("asks for an existing GitHub URL when GitHub CLI is missing", async () => {
  await render();
  await click("Marketplace");
  await click("Vitrine publique");
  await click("Créer une vitrine");
  expect(
    container.querySelector(
      'input[aria-label="URL d’un dépôt existant"], input[aria-label="URL d\'un dépôt existant"]',
    ),
  ).not.toBeNull();
});

it("counts a skill installed for both agents once during inspection", async () => {
  const { api } = await render();
  const artifact = {
    id: "claude-demo",
    physicalIdentity: ".claude/skills/demo/SKILL.md",
    projectionPaths: [".claude/skills/demo/SKILL.md"],
    relativePath: ".claude/skills/demo/SKILL.md",
    displayPath: ".claude/skills/demo/SKILL.md",
    providerIds: ["claude-code"],
    scope: "project",
    confidence: "exact",
    symlinkState: "not-a-symlink",
    kind: "skill",
  };
  const inspection = await api.inspectProject();
  api.inspectProject.mockResolvedValue({
    ...inspection,
    inventory: {
      ...inspection.inventory,
      artifacts: [
        artifact,
        {
          ...artifact,
          id: "support-file",
          physicalIdentity: ".claude/skills/demo/notes.md",
          projectionPaths: [".claude/skills/demo/notes.md"],
          relativePath: ".claude/skills/demo/notes.md",
          displayPath: ".claude/skills/demo/notes.md",
        },
        {
          ...artifact,
          id: "codex-demo",
          physicalIdentity: ".agents/skills/demo/SKILL.md",
          projectionPaths: [".agents/skills/demo/SKILL.md"],
          relativePath: ".agents/skills/demo/SKILL.md",
          displayPath: ".agents/skills/demo/SKILL.md",
          providerIds: ["codex"],
        },
      ],
    },
  } as any);
  await click("Projet");
  await click("Choisir un dossier…");
  expect(container.textContent).toContain("1 skill seulement dans ce projet");
  expect(container.textContent).not.toContain("2 skills seulement dans ce projet");
  expect(container.textContent).toContain("Claude Code (.claude/)");
});
