// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsCard } from "../../src/renderer/settings/AgentsCard";
import { I18nProvider } from "../../src/renderer/i18n";
import { CanvasToastProvider } from "../../src/renderer/canvas/CanvasToast";
import type { AgentStatus } from "../../src/shared/agents-ipc";
import type { DesktopApi } from "../../src/shared/ipc";
import type { AgentMaintenanceState } from "../../src/shared/agent-maintenance-ipc";
const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()));
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const agent: AgentStatus["harnesses"][number] = {
  harness: "claude-code",
  detected: true,
  registered: true,
  current: true,
  guard: true,
  settingsPath: "~/.claude.json",
  skillsPath: "~/.claude/skills",
  skills: [{ name: "omni-lessons", state: "installed" }],
};
function status(overrides: Partial<typeof agent> = {}): AgentStatus {
  return {
    appVersion: "1.2.3",
    socketPath: "socket",
    tokenCreatedAt: "2026-10-11T00:00:00Z",
    counts: { pending: 0, today: 0, total: 0 },
    harnesses: [
      { ...agent, ...overrides },
      { ...agent, harness: "codex", detected: false, registered: false },
    ],
  };
}
function mount(value: AgentStatus, api: DesktopApi = {} as DesktopApi, maintenance?: AgentMaintenanceState) {
  const host = document.createElement("div");
  host.className = "resource-canvas";
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <I18nProvider initialLanguage="fr">
        <CanvasToastProvider>
          <AgentsCard api={api} status={value} loaded maintenance={maintenance} onChanged={async () => undefined} />
        </CanvasToastProvider>
      </I18nProvider>,
    ),
  );
  return host;
}
async function click(host: HTMLElement, text: string): Promise<void> {
  const button = [...host.querySelectorAll("button")].find((button) => button.textContent?.startsWith(text));
  if (!button) throw new Error(`Missing ${text}`);
  await act(async () => {
    button.click();
  });
}
describe("settings agent rows", () => {
  it("shows the last session with an ok dot and checks the last call", async () => {
    const timestamp = new Date(Date.now() - 120_000).toISOString();
    const host = mount(status({ lastSeenAt: timestamp }));
    expect(host.textContent).toContain("dernière session il y a 2 min");
    expect(host.querySelector('[data-agent="claude-code"] .dot.ok')).not.toBeNull();
    await click(host, "⋯");
    await click(host, "Vérifier la connexion");
    expect(host.textContent).toContain("Claude Code a appelé Omni il y a 2 min — tout fonctionne.");
  });
  it.each([{ current: false }, { guard: false }, { skills: [{ name: "omni-lessons", state: "missing" as const }] }])(
    "requires current MCP, guard and every bundled skill before reporting up to date: %o",
    (overrides) => {
      const host = mount(status(overrides));
      expect(host.textContent).toContain("À vérifier : l'installation d'Omni est incomplète");
      expect(host.querySelector('[data-agent="claude-code"] .dot.wait')).not.toBeNull();
    },
  );
  it("shows updating and disables the agent menu during automatic maintenance", () => {
    const host = mount(status(), {} as DesktopApi, { updating: ["claude-code"], failures: [] });
    expect(host.textContent).toContain("Mise à jour…");
    expect(host.querySelector<HTMLButtonElement>('[data-agent="claude-code"] button')?.disabled).toBe(true);
  });
  it("shows the version, waiting for a first session, and an undetected agent without an action", () => {
    const host = mount(status());
    expect(host.textContent).toContain("Connecté · à jour avec Omni 1.2.3 · en attente de la première session");
    expect(host.textContent).toContain("Introuvable sur ce Mac");
    expect(host.querySelector('[data-agent="codex"] button')).toBeNull();
    expect(host.textContent).toContain("Après chaque mise à jour d'Omni, vos agents se mettent à jour tout seuls.");
  });
  it("connects one agent through an anchored popover without a review step", async () => {
    const previewOperation = vi.fn(async () => ({ status: "ready", plan: { planId: "plan" } }));
    const applyOperation = vi.fn(async () => ({ status: "applied", receipt: { operationId: "op", actions: [] } }));
    const host = mount(status({ registered: false }), { previewOperation, applyOperation } as unknown as DesktopApi);
    expect(host.textContent).toContain("Pas connecté");
    expect(host.querySelector('[data-agent="claude-code"] .dot.off')).not.toBeNull();
    await click(host, "Connecter");
    expect(document.activeElement?.textContent).toBe("Annuler");
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      "Omni ajoute à Claude Code l'outil omni, ses skills et la protection des fichiers qu'il gère.",
    );
    expect(previewOperation).not.toHaveBeenCalled();
    await click(host.querySelector('[role="dialog"]') as HTMLElement, "Connecter");
    expect(previewOperation).toHaveBeenCalledWith({ kind: "install-agents", harnesses: ["claude-code"] });
    expect(applyOperation).toHaveBeenCalledWith({ planId: "plan" });
    expect(host.textContent).toContain(
      "Claude Code connecté. Ouvrez une nouvelle session Claude Code pour l'utiliser.",
    );
  });
  it("checks the last call and force reinstalls a complete agent from the menu", async () => {
    const previewOperation = vi.fn(async () => ({ status: "ready", plan: { planId: "plan" } }));
    const applyOperation = vi.fn(async () => ({
      status: "applied",
      receipt: { operationId: "op", actions: [{ kind: "write-file", status: "applied" }] },
    }));
    const host = mount(status(), { previewOperation, applyOperation } as unknown as DesktopApi);
    await click(host, "⋯");
    const menuItem = host.querySelector('[role="menuitem"]')!;
    expect(menuItem.querySelector("span > small")?.textContent).toContain("Dernier appel");
    await click(host, "Vérifier la connexion");
    expect(host.textContent).toContain("Claude Code n'a pas encore appelé Omni");
    await click(host, "⋯");
    await click(host, "Réinstaller");
    expect(previewOperation).toHaveBeenCalledWith({ kind: "install-agents", harnesses: ["claude-code"], force: true });
    expect(host.textContent).toContain("Omni réinstallé dans Claude Code — 1 fichiers remis à jour.");
  });
  it("confirms a disconnection then offers receipt-backed undo", async () => {
    const previewOperation = vi.fn(async (request) => ({
      status: "ready",
      plan: { planId: request.kind === "restore-import" ? "undo" : "disconnect" },
    }));
    const applyOperation = vi.fn(async () => ({ status: "applied", receipt: { operationId: "op", actions: [] } }));
    const host = mount(status(), { previewOperation, applyOperation } as unknown as DesktopApi);
    await click(host, "⋯");
    await click(host, "Déconnecter");
    expect(document.activeElement?.textContent).toBe("Annuler");
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    expect(previewOperation).not.toHaveBeenCalled();
    await click(host.querySelector('[role="dialog"]') as HTMLElement, "Déconnecter");
    expect(previewOperation).toHaveBeenCalledWith({ kind: "disconnect-agents", harnesses: ["claude-code"] });
    await click(host.querySelector(".toast") as HTMLElement, "Annuler");
    expect(previewOperation).toHaveBeenCalledWith({ kind: "restore-import", operationId: "op" });
    expect(applyOperation).toHaveBeenLastCalledWith({ planId: "undo" });
  });
  it("shows a foreign skill with a review dot", () => {
    const host = mount(status({ skills: [{ name: "omni-lessons", state: "foreign" }] }));
    expect(host.textContent).toContain("À vérifier : omni-lessons appartient à un autre outil");
    expect(host.querySelector('[data-agent="claude-code"] .dot.wait')).not.toBeNull();
  });
  it("offers Connecter and names the hand-edited skill kept after disconnection", () => {
    const api = { previewOperation: vi.fn(), applyOperation: vi.fn() } as unknown as DesktopApi;
    const host = mount(status({ registered: false, skills: [{ name: "omni-lessons", state: "outdated" }] }), api);
    expect(host.textContent).toContain("Pas connecté · omni-lessons modifié à la main reste dans Claude Code");
    expect(host.querySelector('[data-agent="claude-code"] button')?.textContent).toBe("Connecter");
  });
});
