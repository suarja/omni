// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import { I18nProvider } from "../../src/renderer/i18n";
import { projectApi, projectSnapshot, projectId, skills } from "./project-view-fixture";
import type { OperationReceipt } from "../../src/shared/operations-ipc";
import type { AgentRequest } from "../../src/shared/agents-ipc";
import type { ResourceContext, ResourceSnapshot } from "../../src/domain/resource-catalogue";
import type { DesktopApi } from "../../src/shared/ipc";
import type { ResourceCanvasProps } from "../../src/renderer/canvas/resource-canvas-types";
import type { ManagedSkillUse } from "../../src/domain/skill-reconciliation/types";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES, DEFAULT_GUARD_SETTINGS } from "../../src/shared/settings-ipc";
import { setupInputs } from "./workspace-setup-fixtures";

let container: HTMLDivElement;
let root: Root;
const navigate = vi.fn();
const destination = vi.fn();
const grant = vi.fn(async () => "grant");
const request: AgentRequest = {
  requestId: "request-1",
  createdAt: "2026-10-11T09:00:00Z",
  expiresAt: "2026-10-12T09:00:00Z",
  harness: "codex",
  sessionName: "Session One",
  status: "pending",
  approval: "omni",
  approvalReason: { code: "deletes-files", count: 1 },
  request: {
    kind: "write-skill",
    sourceId: "source-one",
    packageId: "pstack",
    folderName: "review",
    files: [],
    mode: "update",
  },
  plan: {
    kind: "write-skill",
    planId: "plan-1",
    displayTarget: "pstack",
    actions: [],
    git: { mode: "disabled", warnings: [] },
  },
};
const receipt: OperationReceipt = {
  operationId: "operation-1",
  kind: "write-skill",
  skillMode: "update",
  status: "applied",
  appliedAt: "2026-10-11T09:37:00Z",
  displayTarget: "My Skills",
  actions: [{ kind: "write-file", relativePath: "pstack/skills/codex/SKILL.md", status: "applied" }],
  git: { mode: "disabled" },
  registered: null,
  provenance: {
    agent: { harness: "codex", sessionName: "Session One", requestedAt: "2026-10-11T09:36:00Z" },
    approval: "conversation",
  },
};
function apiFixture() {
  return {
    ...projectApi(),
    listAgentRequests: vi.fn(async () => ({ status: "ready" as const, requests: [request] })),
    listOperations: vi.fn(async () => ({ status: "ready" as const, receipts: [receipt] })),
    observeSource: vi.fn(),
    getAgentStatus: vi.fn(async () => ({
      harnesses: [],
      socketPath: "local",
      tokenCreatedAt: "2026-10-11T00:00:00Z",
      counts: { pending: 1, today: 1, total: 1 },
    })),
  };
}
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  vi.clearAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));
async function render(
  api = apiFixture(),
  context: ResourceContext = { kind: "workspace" },
  snapshot: ResourceSnapshot = projectSnapshot,
  railServices?: ResourceCanvasProps["railServices"],
  setup?: ResourceCanvasProps["setup"],
  language: "fr" | "en" = "fr",
) {
  await act(async () =>
    root.render(
      <ThemeProvider>
        <I18nProvider initialLanguage={language}>
          <ResourceCanvas
            api={api}
            context={context}
            snapshot={snapshot}
            railServices={railServices}
            setup={setup}
            onEnsureGrant={grant}
            onNavigate={navigate}
            onNavigateDestination={destination}
            onRefresh={vi.fn()}
          />
        </I18nProvider>
      </ThemeProvider>,
    ),
  );
  return api;
}
async function click(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label")?.startsWith(label) || button.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
it("opens requests over the canvas with a pending-only badge and the existing review action", async () => {
  await render();
  await click("À valider");
  const sheet = container.querySelector('[data-testid="canvas-review-sheet"]');
  expect(sheet?.textContent).toContain("Demandes des agents");
  expect(sheet?.querySelector('.rail-tile.is-review [data-glyph="skill"]')).not.toBeNull();
  expect(sheet?.textContent).toContain(
    "Ne demande votre accord que pour : suppressions de fichiers, marketplaces qui ne sont pas à vous, ou si l'agent le demande. Les demandes n'expirent pas.",
  );
  expect(sheet?.querySelector('.rail-tile.is-pending [data-glyph="warn"]')).not.toBeNull();
  expect(sheet?.textContent).toContain("Codex · Session One");
  expect(sheet?.textContent).toContain("Supprime 1 fichier");
  expect(container.querySelector('[data-testid="canvas-review-count"]')?.textContent).toBe("1");
  expect(destination).not.toHaveBeenCalled();
  await click("Ouvrir");
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ screen: "resource-canvas", requestId: "request-1" }));
  expect(grant).not.toHaveBeenCalled();
});
it("counts only pending Omni requests and names located observation diagnostics", async () => {
  const api = apiFixture();
  api.listAgentRequests.mockResolvedValue({
    status: "ready",
    requests: [
      request,
      { ...request, requestId: "conversation", approval: "conversation" },
      { ...request, requestId: "finished", status: "declined" },
    ],
  });
  await render(api);
  await click("À valider");
  expect(container.querySelector('[data-testid="canvas-review-count"]')?.textContent).toBe("1");
  expect(container.querySelector('[data-testid="canvas-review-sheet"]')?.textContent).toContain(
    "Personal Skills · plugins/pstack",
  );
  expect(container.querySelector('[data-testid="canvas-review-sheet"]')?.textContent).toContain("Git unavailable");
  expect(api.readProjectSkills).not.toHaveBeenCalled();
  expect(grant).not.toHaveBeenCalled();
});
it("names partial workspace locations and requires confirmation to remove a missing project", async () => {
  const snapshot = {
    ...projectSnapshot,
    registry: {
      ...projectSnapshot.registry,
      projects: projectSnapshot.registry.projects.map((project) =>
        project.ref.id === "project-two" ? { ...project, availability: "missing" as const } : project,
      ),
    },
  };
  let complete!: () => void;
  const archiveEntry = vi.fn(
    () =>
      new Promise<never>((resolve) => {
        complete = () => resolve({ status: "ready", registry: { ...snapshot.registry, revision: 2 } } as never);
      }),
  );
  const api = { ...apiFixture(), archiveEntry };
  await render(api, { kind: "workspace" }, snapshot);
  expect(container.querySelector(".canvas-stage-heading")?.textContent).toContain("Project Two");
  await click("À valider");
  await click("Retirer de l’espace");
  expect(container.querySelector('[data-testid="missing-projects-sheet"]')).not.toBeNull();
  expect(archiveEntry).not.toHaveBeenCalled();
  const confirm = container.querySelector<HTMLButtonElement>('[data-testid="missing-projects-sheet"] footer button');
  await act(async () => confirm!.click());
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(container.querySelector('[data-testid="missing-projects-sheet"]')).not.toBeNull();
  await act(async () => complete());
  expect(archiveEntry).toHaveBeenCalledExactlyOnceWith({ kind: "project", id: "project-two", expectedRevision: 1 });
  expect(container.querySelector('[data-testid="missing-projects-sheet"]')).toBeNull();
  expect(grant).not.toHaveBeenCalled();
  expect(api.observeSource).not.toHaveBeenCalled();
});
it("moves keyboard focus through Add entries and returns it to the toolbar after Escape", async () => {
  await render(
    apiFixture(),
    { kind: "workspace" },
    projectSnapshot,
    undefined,
    setupInputs({ snapshot: projectSnapshot }),
  );
  await click("＋ Ajouter");
  const menu = container.querySelector<HTMLElement>('[data-testid="canvas-setup-menu"]')!;
  const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  expect(items).toHaveLength(3);
  expect(document.activeElement).toBe(items[0]);
  await act(async () => items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect(document.activeElement).toBe(items[1]);
  await act(async () => items[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement).toBe(items.at(-1));
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(container.querySelector('[data-testid="canvas-setup-menu"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('[data-testid="canvas-setup-menu-trigger"]'));
});
it("drops cached project checks when their observed root changes", async () => {
  const api = await render(apiFixture(), { kind: "entry", entry: { kind: "project", id: projectId } });
  await click("À valider");
  expect(container.textContent).toContain("une mise à jour est disponible");
  await click("Fermer");
  const changed = {
    ...projectSnapshot,
    roots: projectSnapshot.roots.map((root) =>
      root.entry.id === projectId ? { ...root, evidence: { status: "unobserved" as const } } : root,
    ),
  };
  api.readProjectSkills.mockRejectedValueOnce(new Error("Project read is unavailable"));
  await render(api, { kind: "entry", entry: { kind: "project", id: projectId } }, changed);
  await render(api, { kind: "workspace" }, changed);
  await click("À valider");
  expect(container.querySelector('[data-testid="canvas-review-sheet"]')?.textContent).not.toContain(
    "une mise à jour est disponible",
  );
});
it("keeps legacy binding grants behind an explicit expansion", async () => {
  const api = { ...apiFixture(), previewBindings: vi.fn(async () => ({ status: "ready" as const, plans: [] })) };
  const services: ResourceCanvasProps["railServices"] = {
    api: api as unknown as DesktopApi,
    audit: { status: "idle", report: null },
    mode: "light",
    onModeChange: vi.fn(),
  };
  await render(api, { kind: "workspace" }, projectSnapshot, services);
  await click("À valider");
  expect(grant).not.toHaveBeenCalled();
  expect(api.previewBindings).not.toHaveBeenCalled();
  const section = container.querySelector<HTMLDetailsElement>('[data-testid="canvas-review-sheet"] details')!;
  await act(async () => {
    section.open = true;
    section.dispatchEvent(new Event("toggle"));
  });
  expect(api.previewBindings).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-testid="review-pending"]')).not.toBeNull();
});
it("offers no undo for restored operations", async () => {
  const api = apiFixture();
  api.listOperations.mockResolvedValue({ status: "ready", receipts: [{ ...receipt, restored: true }] });
  await render(api);
  await click("Historique");
  expect(
    [...container.querySelectorAll('[data-testid="canvas-history-sheet"] button')].some(
      (button) => button.textContent === "Annuler",
    ),
  ).toBe(false);
});
it("uses skill checks already loaded in the session and opens maintenance or agent installation", async () => {
  const api = await render(apiFixture(), { kind: "entry", entry: { kind: "project", id: projectId } });
  const reads = api.readProjectSkills.mock.calls.length;
  const grants = grant.mock.calls.length;
  await click("À valider");
  expect(container.querySelector('[data-testid="canvas-review-sheet"]')?.textContent).toContain("review");
  await click("Mettre à jour");
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ initialSkillIntent: expect.objectContaining({ kind: "maintain-current" }) }),
  );
  await click("À valider");
  expect(container.querySelector('[data-testid="canvas-review-sheet"]')?.textContent).toContain(
    "grill-me n'est installé que pour Claude Code",
  );
  expect(container.querySelector('[data-testid="canvas-review-sheet"]')?.textContent).toContain(
    "Project One — L'autre agent ne le voit pas",
  );
  await click("Installer pour Codex");
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      initialSkillIntent: expect.objectContaining({
        kind: "project-skill",
        action: "install-agent",
        harnessIds: ["codex"],
      }),
    }),
  );
  expect(api.readProjectSkills).toHaveBeenCalledTimes(reads);
  expect(grant).toHaveBeenCalledTimes(grants);
  expect(api.observeSource).not.toHaveBeenCalled();
});
it("shows operation attribution and opens result and restore in the canvas workbench", async () => {
  await render();
  await click("Historique");
  const sheet = container.querySelector('[data-testid="canvas-history-sheet"]');
  expect(sheet?.textContent).toContain("codex");
  expect(sheet?.textContent).toContain("Codex · Session One");
  expect(sheet?.textContent).toContain("conversation");
  expect(sheet?.querySelector("time")?.getAttribute("datetime")).toBe(receipt.appliedAt);
  expect(sheet?.querySelector(".rail-history-entry")).not.toBeNull();
  await act(async () => sheet?.querySelector<HTMLButtonElement>(".rail-history-entry")?.click());
  expect(navigate).toHaveBeenLastCalledWith({
    screen: "operation-receipt",
    operationId: receipt.operationId,
    returnTo: { screen: "resource-canvas", context: { kind: "workspace" }, initialRailSurface: "activity" },
  });
  await click("Historique");
  await click("Annuler");
  expect(navigate).toHaveBeenLastCalledWith({ screen: "operation-restore", operationId: receipt.operationId });
});
it("keeps settings and the three add entries available on a project canvas", async () => {
  await render(apiFixture(), { kind: "entry", entry: { kind: "project", id: projectId } });
  await click("Réglages");
  expect(container.querySelector('[data-testid="canvas-settings-sheet"]')?.textContent).toContain(
    "Quand un agent modifie vos skills",
  );
  await click("Fermer");
  await click("＋ Ajouter");
  const entries = [...container.querySelectorAll('[data-testid="canvas-setup-menu"] [role="menuitem"]')].map((item) =>
    item.querySelector("b")?.textContent?.trim(),
  );
  expect(entries).toEqual(["Projet", "Marketplace", "Nouveau skill"]);
  await click("Nouveau skill");
  expect(container.querySelector('[data-testid="new-skill-sheet"]')).not.toBeNull();
  expect(destination).not.toHaveBeenCalled();
});
it("shows honest empty and unavailable request or history states without observing roots", async () => {
  const api = apiFixture();
  api.listAgentRequests.mockResolvedValue({ status: "ready", requests: [] });
  api.listOperations.mockResolvedValue({ status: "ready", receipts: [] });
  await render(api);
  await click("À valider");
  expect(container.querySelector('[data-testid="canvas-review-sheet"]')?.textContent).toContain(
    "Aucune demande en attente",
  );
  expect(container.querySelector('[data-testid="canvas-review-count"]')).toBeNull();
  await click("Historique");
  expect(container.querySelector('[data-testid="canvas-history-sheet"]')?.textContent).toContain("Aucune opération");
  expect(grant).not.toHaveBeenCalled();
  expect(api.observeSource).not.toHaveBeenCalled();
  expect(api.readProjectSkills).not.toHaveBeenCalled();
});
it("names project skill changes in plain words and keeps newest operations first", async () => {
  const api = apiFixture();
  api.listOperations.mockResolvedValue({
    status: "ready",
    receipts: [
      receipt,
      {
        ...receipt,
        operationId: "newer",
        kind: "skill-management",
        displayTarget: "disable · local-tool",
        appliedAt: "2026-10-11T10:00:00Z",
      },
    ],
  });
  await render(api);
  await click("Historique");
  expect(container.querySelector('[data-testid="canvas-history-sheet"] .rail-item strong')?.textContent).toBe(
    "Désactivation du skill local-tool",
  );
});
it("reports unavailable history and request reads without presenting them as empty", async () => {
  const api = apiFixture();
  api.listAgentRequests.mockRejectedValue(new Error("Unavailable"));
  api.listOperations.mockRejectedValue(new Error("Unavailable"));
  await render(api);
  await click("À valider");
  expect(container.querySelector('[data-testid="canvas-review-sheet"] [role="alert"]')).not.toBeNull();
  await click("Historique");
  expect(container.querySelector('[data-testid="canvas-history-sheet"] [role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Aucune opération");
});
it("does not scan agent activity until its collapsed section is explicitly opened", async () => {
  const api = { ...apiFixture(), getActivitySnapshot: vi.fn() };
  await render(api);
  await click("Historique");
  expect(api.getActivitySnapshot).not.toHaveBeenCalled();
});
it("keeps setup and menu entries on every canvas level", async () => {
  const api = apiFixture();
  for (const context of [
    { kind: "workspace" },
    { kind: "entry", entry: { kind: "source", id: "source-one" } },
    { kind: "package", entry: { kind: "source", id: "source-one" }, packageId: "pstack" },
  ] as const) {
    await render(api, context);
    await click("＋ Ajouter");
    expect(container.querySelectorAll('[data-testid="canvas-setup-menu"] [role="menuitem"]')).toHaveLength(3);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  }
});
it("draws workspace wires from managed relationships even before their projects are observed", async () => {
  const use: ManagedSkillUse = {
    skillId: "11111111-1111-4111-8111-111111111111",
    bindingId: "managed-1",
    source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" },
    location: { projectId: "project-two", harnessId: "codex", folderPath: ".agents/skills/review" },
    baseRevisionId: "22222222-2222-4222-8222-222222222222",
  };
  const api = {
    ...apiFixture(),
    readWorkspaceSkillUses: vi.fn(async () => ({ status: "ready" as const, uses: [use] })),
  };
  await render(api);
  expect(container.querySelectorAll(".canvas-wire")).toHaveLength(2);
  expect(grant).not.toHaveBeenCalled();
  expect(api.readProjectSkills).not.toHaveBeenCalled();
  expect(api.observeSource).not.toHaveBeenCalled();
});
it("persists approval and Git choices through the existing settings command from the sheet", async () => {
  const api = {
    ...apiFixture(),
    getSettings: vi.fn(async () => ({
      schemaVersion: 8 as const,
      git: { commitChanges: true },
      agents: {
        approval: { personalMarketplace: "conversation" as const, projects: "omni" as const },
        guard: DEFAULT_GUARD_SETTINGS,
      },
      ai: DEFAULT_AI_SETTINGS,
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "ask" as const },
    })),
    setSettings: vi.fn(async () => ({
      schemaVersion: 8 as const,
      git: { commitChanges: false },
      agents: {
        approval: { personalMarketplace: "conversation" as const, projects: "omni" as const },
        guard: DEFAULT_GUARD_SETTINGS,
      },
      ai: DEFAULT_AI_SETTINGS,
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "ask" as const },
    })),
  };
  await render(api);
  await click("Réglages");
  const git = container.querySelector<HTMLButtonElement>('[data-testid="settings-git-control"] [role="switch"]');
  await act(async () => git!.click());
  expect(api.setSettings).toHaveBeenCalledWith(
    expect.objectContaining({
      commitChanges: false,
      externalLibrary: { updates: "ask" },
      agents: expect.objectContaining({ approval: { personalMarketplace: "conversation", projects: "omni" } }),
    }),
  );
  const approval = container.querySelector('[data-testid="canvas-settings-sheet"] .settings-approval');
  const omni = [...approval!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes("Omni"),
  );
  await act(async () => omni!.click());
  expect(api.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      commitChanges: false,
      agents: expect.objectContaining({ approval: { personalMarketplace: "omni", projects: "omni" } }),
    }),
  );
});

it.each(["fr", "en"] as const)("names Codex when it is the only installed agent in %s", async (language) => {
  const api = apiFixture();
  api.readProjectSkills.mockResolvedValue({
    ...skills,
    skills: [
      {
        ...skills.skills[1]!,
        agents: {
          "claude-code": { state: "absent" },
          codex: { state: "installed", folderPath: ".agents/skills/grill-me" },
        },
      },
    ],
  });
  await render(
    api,
    { kind: "entry", entry: { kind: "project", id: projectId } },
    projectSnapshot,
    undefined,
    undefined,
    language,
  );
  await click(language === "fr" ? "À valider" : "Review");
  const sheet = container.querySelector('[data-testid="canvas-review-sheet"]')!;
  expect(sheet.textContent).toContain(
    language === "fr" ? "grill-me n'est installé que pour Codex" : "grill-me is only installed for Codex",
  );
  expect(sheet.textContent).toContain(
    language === "fr" ? "Project One — L'autre agent ne le voit pas" : "Project One — The other agent cannot see it",
  );
});

it("shows the automatic agent update toast and opens its receipt in History", async () => {
  const api = Object.assign(apiFixture(), {
    getAgentMaintenance: vi.fn(async () => ({
      updating: [],
      failures: [],
      notice: { id: "auto-update-1", version: "1.2.3", harnesses: ["claude-code", "codex"] },
    })),
  });
  api.listOperations.mockResolvedValue({
    status: "ready",
    receipts: [
      {
        ...receipt,
        kind: "install-agents",
        agentSetup: { action: "update", harnesses: ["claude-code", "codex"], version: "1.2.3" },
        provenance: { approval: "automatic" },
      },
    ],
  });
  await render(api);
  const toast = container.querySelector(".toast");
  expect(toast?.textContent).toContain("Omni est passé en 1.2.3 — Claude Code et Codex sont à jour.");
  const details = [...toast!.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Détails",
  );
  await act(async () => details!.click());
  expect(container.querySelector('[data-testid="canvas-history-sheet"]')).not.toBeNull();
  expect(container.textContent).toContain("Omni mis à jour pour Claude Code et Codex");
  expect(container.textContent).toContain("automatique, au premier lancement après la mise à jour");
});

it("shows a failed automatic update in Review and retries only when asked", async () => {
  const retryAgentUpdate = vi.fn(async () => ({ updating: [], failures: [] }));
  const api = Object.assign(apiFixture(), {
    getAgentMaintenance: vi.fn(async () => ({
      updating: [],
      failures: [{ harness: "codex", reason: "Settings are invalid." }],
    })),
    retryAgentUpdate,
  });
  await render(api);
  expect(container.querySelector('[data-testid="canvas-review-count"]')?.textContent).toBe("2");
  expect(retryAgentUpdate).not.toHaveBeenCalled();
  await click("À valider");
  expect(container.textContent).toContain("Omni n'a pas pu se mettre à jour dans Codex");
  expect(container.textContent).toContain("Settings are invalid.");
  await click("Réessayer");
  expect(retryAgentUpdate).toHaveBeenCalledOnce();
  expect(retryAgentUpdate).toHaveBeenCalledWith({ harness: "codex" });
});

it("Escape closes the agent menu while keeping Settings open", async () => {
  const api = apiFixture();
  api.getAgentStatus.mockResolvedValue({
    socketPath: "local",
    tokenCreatedAt: "2026-10-11T00:00:00Z",
    counts: { pending: 0, today: 0, total: 0 },
    harnesses: [
      {
        harness: "claude-code",
        detected: true,
        registered: true,
        current: true,
        guard: true,
        settingsPath: "~/.claude.json",
        skillsPath: "~/.claude/skills",
        skills: [],
      },
    ],
  } as never);
  await render(api);
  await click("Réglages");
  const more = container.querySelector<HTMLButtonElement>('[data-agent="claude-code"] .more');
  await act(async () => more!.click());
  expect(container.querySelector(".canvas-menu")).not.toBeNull();
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector(".canvas-menu")).toBeNull();
  expect(container.querySelector('[data-testid="canvas-settings-sheet"]')).not.toBeNull();
});
