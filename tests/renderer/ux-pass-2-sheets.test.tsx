// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { SheetFrame } from "../../src/renderer/canvas/SheetFrame";
import { I18nProvider } from "../../src/renderer/i18n";
import { projectApi, projectId, projectSnapshot } from "./project-view-fixture";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES } from "../../src/shared/settings-ipc";

let container: HTMLDivElement;
let root: Root;
const settings = {
  schemaVersion: 8 as const,
  git: { commitChanges: true },
  agents: {
    approval: { personalMarketplace: "conversation" as const, projects: "omni" as const },
    guard: { warnProjectIds: [projectId] },
  },
  ai: DEFAULT_AI_SETTINGS,
  features: DEFAULT_FEATURES,
  externalLibrary: { updates: "auto" as const },
};
const fixture = () => ({
  ...projectApi(),
  getSettings: vi.fn(async () => settings),
  setSettings: vi.fn(async () => settings),
  setGuardProjectMode: vi.fn(async () => ({ warnProjectIds: [] })),
  getOperationPaths: vi.fn(async () => ({ store: { displayRoot: "~/operations" } })),
  getAgentStatus: vi.fn(async () => ({
    socketPath: "~/omni.sock",
    tokenCreatedAt: "2026-10-11",
    counts: { pending: 0, today: 0, total: 0 },
    harnesses: [],
  })),
  rotateAgentToken: vi.fn(async () => ({
    socketPath: "~/omni.sock",
    tokenCreatedAt: "2026-10-12",
    counts: { pending: 0, today: 0, total: 0 },
    harnesses: [],
  })),
});
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function render(project = false, api = fixture(), navigate = vi.fn()) {
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage="fr">
        <ResourceCanvas
          api={api}
          context={project ? { kind: "entry", entry: { kind: "project", id: projectId } } : { kind: "workspace" }}
          snapshot={projectSnapshot}
          onEnsureGrant={vi.fn(async () => "grant")}
          onNavigate={navigate}
          onNavigateDestination={vi.fn()}
          onRefresh={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  return api;
}
async function click(label: string, scope: ParentNode = container) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
function press(target: Element, type: string, x: number, y: number, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, button, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => target.dispatchEvent(event));
}
it("renders every sheet slot in the shared grammar", async () => {
  await act(async () =>
    root.render(
      <I18nProvider>
        <SheetFrame
          title="Title"
          subtitle="Subtitle"
          kicker="Kicker"
          tabs={<nav role="tablist">Tabs</nav>}
          footer={<span>Footer</span>}
          testId="frame"
          busy={false}
          onClose={vi.fn()}
        >
          <p>Body</p>
        </SheetFrame>
      </I18nProvider>,
    ),
  );
  expect(container.querySelector(".sheet .sh-head .sh-kicker")?.textContent).toBe("Kicker");
  expect(container.querySelector(".sh-title")?.textContent).toBe("Title");
  expect(container.querySelector(".sh-sub")?.textContent).toBe("Subtitle");
  expect(container.querySelector(".sh-body")?.textContent).toBe("Body");
  expect(container.querySelector(".sh-foot")?.textContent).toBe("Footer");
});
it.each([false, true])("orders the shared rail and marks only the open sheet on project=%s", async (project) => {
  await render(project);
  const rail = container.querySelector(".canvas-rail")!;
  expect([...rail.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
    "Accueil",
    "À valider",
    "Historique",
    "Réglages",
  ]);
  expect(rail.querySelector(".canvas-rail-separator")).not.toBeNull();
  expect(rail.querySelector("button")?.hasAttribute("aria-pressed")).toBe(false);
  expect(rail.querySelector("button")?.getAttribute("aria-current")).toBe(project ? null : "page");
  await click("Réglages", rail);
  expect(rail.querySelector('[aria-label="Réglages"]')?.getAttribute("aria-pressed")).toBe("true");
  await click("Réglages", rail);
  expect(rail.querySelector('[aria-label="Réglages"]')?.getAttribute("aria-pressed")).toBe("false");
});
it("orders settings and keeps advanced paths collapsed", async () => {
  await render();
  await click("Réglages");
  const panel = container.querySelector('[data-testid="settings-page"]')!;
  expect(
    [
      ...panel.querySelectorAll(":scope > .settings-groups > .sec > h3, :scope > .settings-groups > details > summary"),
    ].map((h) => h.firstChild?.textContent?.trim()),
  ).toEqual([
    "Agents",
    "Quand un agent modifie vos skills",
    "Marketplace",
    "Démarrage",
    "Langue",
    "À propos",
    "Avancé",
    "Développement",
  ]);
  expect(panel.textContent).not.toContain("Apparence");
  expect(panel.textContent).not.toContain("Revoir la configuration");
  expect(panel.querySelector("details")?.open).toBe(false);
  expect(panel.querySelector('[data-testid="settings-agents-guard"]')).toBeNull();
});
it("moves the guard to project Info and writes the selected mode", async () => {
  const api = await render(true);
  await click("Gérer les skills");
  await click("Infos");
  const protection = container.querySelector('[data-testid="project-protection"]')!;
  expect(protection?.textContent).toContain("Permises, avec un avertissement");
  await click("Passer par Omni", protection);
  expect(api.setGuardProjectMode).toHaveBeenCalledExactlyOnceWith({ projectId, warn: false });
  expect(protection.textContent).toContain("Arrêtées : l'agent passe par Omni");
});
it.each([false, true])("closes a sheet only after a primary empty canvas click on project=%s", async (project) => {
  await render(project);
  await click("Réglages");
  const stage = container.querySelector(".canvas-stage")!;
  press(stage, "pointerdown", 100, 100);
  press(stage, "pointermove", 105, 100);
  press(stage, "pointerup", 100, 100);
  expect(container.querySelector('[data-testid="canvas-settings-sheet"]')).not.toBeNull();
  press(stage, "pointerdown", 100, 100, 2);
  press(stage, "pointerup", 100, 100, 2);
  expect(container.querySelector('[data-testid="canvas-settings-sheet"]')).not.toBeNull();
  press(stage, "pointerdown", 100, 100);
  press(stage, "pointerup", 103, 100);
  expect(container.querySelector('[data-testid="canvas-settings-sheet"]')).toBeNull();
});
it("expires a canvas toast after six seconds and resumes for 2.5 seconds after hover", async () => {
  vi.useFakeTimers();
  await render(true);
  await click("Gérer les skills");
  await click("+ Codex", container.querySelector('[data-skill-row-id="local-tool"]')!);
  const toast = container.querySelector<HTMLElement>('[role="status"]')!;
  expect(toast.classList.contains("canvas-toast")).toBe(true);
  expect(toast.querySelector(".canvas-toast-bar")).not.toBeNull();
  act(() => vi.advanceTimersByTime(5000));
  act(() => toast.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  act(() => vi.advanceTimersByTime(7000));
  expect(toast.isConnected).toBe(true);
  act(() => toast.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })));
  act(() => vi.advanceTimersByTime(2499));
  expect(toast.isConnected).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(toast.isConnected).toBe(false);
});

it("hides development settings in packaged builds without losing normal settings", async () => {
  vi.stubEnv("DEV", false);
  await render();
  await click("Réglages");
  expect(container.querySelector('[data-testid="settings-development"]')).toBeNull();
  expect(container.textContent).not.toContain("Fonctions expérimentales");
  expect(container.textContent).toContain("Un commit Git par changement");
});
it("binds each approval row, Git and the language to the current choices", async () => {
  const api = await render();
  await click("Réglages");
  await click("Dans Omni", container.querySelector('[aria-label="Approbation de la marketplace personnelle"]')!);
  expect(api.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      agents: { approval: { personalMarketplace: "omni", projects: "omni" }, guard: settings.agents.guard },
    }),
  );
  await click("Dans la conversation", container.querySelector('[aria-label="Approbation des projets"]')!);
  expect(api.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      agents: { approval: { personalMarketplace: "omni", projects: "conversation" }, guard: settings.agents.guard },
    }),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="settings-git-control"] button')!.click(),
  );
  expect(api.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ commitChanges: false }));
  await click("English", container.querySelector('[data-testid="settings-language-control"]')!);
  expect(container.textContent).toContain("When an agent changes your skills");
});
it("keeps node and heading presses from closing a sheet", async () => {
  await render(true);
  await click("Gérer les skills");
  const heading = container.querySelector(".project-stage-heading")!;
  press(heading, "pointerdown", 100, 100);
  press(heading, "pointerup", 100, 100);
  const node = container.querySelector(".canvas-node-row")!;
  press(node, "pointerdown", 100, 100);
  press(node, "pointerup", 100, 100);
  expect(container.querySelector('[data-testid="project-sheet"]')).not.toBeNull();
  const stage = container.querySelector(".canvas-stage")!;
  press(stage, "pointerdown", 100, 100);
  press(stage, "pointerup", 104, 100);
  expect(container.querySelector('[data-testid="project-sheet"]')).not.toBeNull();
  press(stage, "pointerdown", 100, 100);
  press(stage, "pointerup", 100, 100);
  expect(container.querySelector('[data-testid="project-sheet"]')).toBeNull();
});
it("expires an untouched toast and closes a second toast with its close button", async () => {
  vi.useFakeTimers();
  await render(true);
  await click("Gérer les skills");
  const row = container.querySelector('[data-skill-row-id="local-tool"]')!;
  await click("+ Codex", row);
  act(() => vi.advanceTimersByTime(5999));
  expect(container.querySelector(".canvas-toast")).not.toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(container.querySelector(".canvas-toast")).toBeNull();
  await click("+ Codex", row);
  await click("Fermer", container.querySelector(".canvas-toast")!);
  expect(container.querySelector(".canvas-toast")).toBeNull();
});
it.each([
  [700, 100, 1440, 920, 404, 126],
  [4, 800, 600, 850, 12, 718],
])("anchors confirmation at %s/%s and clamps it inside %s/%s", async (x, y, canvasWidth, canvasHeight, left, top) => {
  const api = await render(true);
  await click("Gérer les skills");
  const canvas = container.querySelector<HTMLElement>(".resource-canvas")!;
  const trigger = container.querySelector<HTMLButtonElement>('[data-skill-row-id="review"] [role="switch"]')!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: canvasWidth,
    bottom: canvasHeight,
    width: canvasWidth,
    height: canvasHeight,
  } as DOMRect);
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    left: x,
    top: y,
    right: x + 34,
    bottom: y + 20,
    width: 34,
    height: 20,
  } as DOMRect);
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!;
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains("canvas-pop") ? 330 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains("canvas-pop") ? 120 : 0;
    },
  });
  try {
    await act(async () => trigger.click());
    const pop = container.querySelector<HTMLElement>('[data-testid="project-confirmation"]')!;
    expect(pop.style.left).toBe(`${left}px`);
    expect(pop.style.top).toBe(`${top}px`);
    expect(api.applySkillOperation).not.toHaveBeenCalled();
    press(canvas, "pointerdown", 30, 30);
    expect(container.querySelector('[data-testid="project-confirmation"]')).toBeNull();
    expect(container.querySelector('[data-testid="project-sheet"]')).not.toBeNull();
  } finally {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
    vi.restoreAllMocks();
  }
});

it("keeps token rotation in Advanced and opens My Marketplace from Settings", async () => {
  const api = fixture();
  const navigate = vi.fn();
  await render(false, api, navigate);
  await click("Réglages");
  expect(container.querySelector('[data-testid="settings-agents"]')?.textContent).not.toContain("~/omni.sock");
  const advanced = container.querySelector<HTMLDetailsElement>(".settings-advanced")!;
  expect(advanced.open).toBe(false);
  expect(advanced.textContent).toContain("~/omni.sock");
  expect(advanced.textContent).toContain("~/operations");
  act(() => {
    advanced.open = true;
  });
  await click("Renouveler", advanced);
  expect(api.rotateAgentToken).toHaveBeenCalledExactlyOnceWith();
  await click("Ouvrir", container.querySelector(".settings-git")!);
  expect(container.querySelector("[data-testid=my-marketplace-sheet]")).toBeNull();
  expect(navigate).toHaveBeenCalledWith({
    screen: "resource-canvas",
    context: { kind: "workspace" },
    canvasPage: { kind: "marketplace" },
  });
});

it("shows the normative Add menu copy and closes only its menu with Escape", async () => {
  await render();
  await click("＋ Ajouter");
  const menu = container.querySelector('[data-testid="canvas-setup-menu"]')!;
  expect([...menu.querySelectorAll("b")].map((b) => b.textContent)).toEqual(["Projet", "Marketplace", "Nouveau skill"]);
  expect([...menu.querySelectorAll("small")].map((s) => s.textContent)).toEqual([
    "Un dossier de code où travaillent vos agents",
    "Une source externe, ou une autre marketplace à vous",
    "Écrit par votre agent ou par vous, rangé dans votre marketplace",
  ]);
  await act(async () => {
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(container.querySelector('[data-testid="canvas-setup-menu"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('[data-testid="canvas-setup-menu-trigger"]'));
});

it.each([false, true])("keeps an open Settings sheet when Add opens and closes (project=%s)", async (project) => {
  await render(project);
  await click("Réglages");
  const sheet = container.querySelector('[data-testid="canvas-settings-sheet"]');
  await click("＋ Ajouter");
  expect(container.querySelector('[data-testid="canvas-settings-sheet"]')).toBe(sheet);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('[data-testid="canvas-setup-menu"]')).toBeNull();
  expect(container.querySelector('[data-testid="canvas-settings-sheet"]')).toBe(sheet);
});
it("uses typed project tiles and puts management in the stage heading", async () => {
  await render(true);
  const tones = {
    project: "project",
    mine: "marketplace",
    external: "external",
    "project-only": "skill",
    "instructions:0": "doc",
    cost: "group",
  };
  const nodes = [...container.querySelectorAll(".project-node")];
  for (const [id, tone] of Object.entries(tones)) {
    const node =
      id === "instructions:0"
        ? nodes.find((node) => node.textContent?.includes("Instructions ·"))
        : id === "cost"
          ? nodes.find((node) => node.textContent?.includes("Coût au démarrage"))
          : id === "project"
            ? container.querySelector(".project-node.is-center")
            : container.querySelector(`[data-project-group="${id}"]`);
    expect(node?.getAttribute("data-tone")).toBe(tone);
    expect(node?.querySelector("[data-glyph]")?.getAttribute("data-glyph")).toBe(tone);
  }
  expect(container.querySelector(".project-stage-heading")?.textContent).toContain("4 skills · Claude Code et Codex");
  const manage = [...container.querySelectorAll("button")].find((button) => button.textContent === "Gérer les skills")!;
  expect(manage.closest(".project-stage-heading")).not.toBeNull();
  expect(container.querySelector(".canvas-header")?.textContent).not.toContain("Gérer les skills");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-project-group="mine"] .canvas-node')?.click(),
  );
  expect(container.querySelector(".project-stage-heading")?.textContent).toContain(
    "2 skills — un nœud par skill, pastilles par agent",
  );
});
it("shows the workspace stage title and exact toolbar controls", async () => {
  await render();
  expect(container.querySelector(".canvas-stage-heading .stage-title")?.textContent).toBe("Espace de travail");
  const toolbar = container.querySelector(".canvas-header")!;
  expect(toolbar.querySelector(".canvas-search-trigger")?.textContent).toBe("Rechercher un skill, un projet⌘K");
  expect(toolbar.textContent).toContain("? Aide");
  expect([...toolbar.querySelectorAll("button")].some((button) => button.textContent?.trim() === "‹")).toBe(false);
});
it("shows the abbreviated registered marketplace path rather than its name", async () => {
  const api = fixture();
  api.getOperationPaths.mockResolvedValue({
    store: { displayRoot: "~/operations" },
    marketplace: { displayRoot: "~/skills" },
  } as Awaited<ReturnType<typeof api.getOperationPaths>>);
  await render(false, api);
  await click("Réglages");
  expect(container.querySelector(".settings-git .item small")?.textContent).toBe("~/skills");
});

it("keeps the project skills sheet when Add opens and closes", async () => {
  await render(true);
  await click("Gérer les skills");
  const sheet = container.querySelector('[data-testid="project-sheet"]');
  expect(sheet).not.toBeNull();
  await click("＋ Ajouter");
  expect(container.querySelector('[data-testid="project-sheet"]')).toBe(sheet);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('[data-testid="canvas-setup-menu"]')).toBeNull();
  expect(container.querySelector('[data-testid="project-sheet"]')).toBe(sheet);
});

it("reuses the complete project skill total after reading it in the session", async () => {
  const api = fixture();
  await render(true, api);
  await render(false, api);
  const project = container.querySelector(`[data-testid="canvas-entry-project-${projectId}"]`);
  expect(project?.querySelector(".canvas-node-meta")?.textContent).toBe("4 skills");
  expect(api.readProjectSkills).toHaveBeenCalledTimes(1);
});
