// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentsView } from "../../src/renderer/activity/AgentsView";
import { WorktreesView } from "../../src/renderer/activity/WorktreesView";
import { I18nProvider } from "../../src/renderer/i18n";
import type { ActivitySnapshot } from "../../src/shared/activity-ipc";
import type { AgentStatus } from "../../src/shared/agents-ipc";
import type { DesktopApi } from "../../src/shared/ipc";

const emptySnapshot: ActivitySnapshot = { sessions: [], processes: [], worktrees: [], platformSupported: true };

function render(element: ReactElement, language: "en" | "fr" = "en"): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(<I18nProvider initialLanguage={language}>{element}</I18nProvider>));
  return { container, root };
}

function activityApi(snapshot = emptySnapshot): DesktopApi {
  return { getActivitySnapshot: vi.fn().mockResolvedValue({ status: "ready", snapshot }) } as unknown as DesktopApi;
}

function agentStatus(): AgentStatus {
  return {
    socketPath: "~/.omni/agent.sock",
    tokenCreatedAt: "2026-09-14T00:00:00.000Z",
    counts: { pending: 0, today: 0, total: 0 },
    harnesses: [
      {
        harness: "claude-code",
        detected: true,
        registered: true,
        settingsPath: "~/.claude.json",
        skillsPath: "~/.claude/skills",
        current: false,
        guard: false,
        skills: [
          { name: "omni-lessons", state: "missing" },
          { name: "omni-project-sync", state: "missing" },
          { name: "omni-review", state: "missing" },
          { name: "omni-status", state: "missing" },
        ],
      },
      {
        harness: "codex",
        detected: false,
        registered: false,
        settingsPath: "~/.codex/config.toml",
        skillsPath: "~/.codex/skills",
        current: false,
        guard: false,
        skills: [],
      },
    ],
  };
}

describe("activity agent review findings", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    vi.restoreAllMocks();
  });

  it("shows loading items until the first snapshot and empty items afterward", async () => {
    const pendingSnapshot = new Promise<never>(() => undefined);
    rendered = render(
      <AgentsView api={{ getActivitySnapshot: vi.fn(() => pendingSnapshot) } as unknown as DesktopApi} />,
    );
    expect(rendered.container.querySelector("[data-testid=loading-skeleton]")?.getAttribute("aria-label")).toBe(
      "Loading Activity",
    );
    expect(rendered.container.textContent).not.toContain("No agent sessions right now");
    act(() => rendered?.root.unmount());

    rendered = render(
      <WorktreesView api={{ getActivitySnapshot: vi.fn(() => pendingSnapshot) } as unknown as DesktopApi} />,
    );
    expect(rendered.container.querySelector("[data-testid=loading-skeleton]")?.getAttribute("aria-label")).toBe(
      "Loading Activity",
    );
    expect(rendered.container.textContent).not.toContain("No worktrees right now");
    act(() => rendered?.root.unmount());

    rendered = render(<AgentsView api={activityApi()} />);
    await act(async () => await Promise.resolve());
    expect(rendered.container.textContent).toContain("No agent sessions right now");
    act(() => rendered?.root.unmount());

    rendered = render(<WorktreesView api={activityApi()} />);
    await act(async () => await Promise.resolve());
    expect(rendered.container.textContent).toContain("No worktrees right now");
  });

  it("uses the shared English and French harness summaries in the head", async () => {
    const api = { ...activityApi(), getAgentStatus: vi.fn().mockResolvedValue(agentStatus()) } as unknown as DesktopApi;
    rendered = render(<AgentsView api={api} />, "en");
    await act(async () => await Promise.resolve());
    expect(rendered.container.textContent).toContain(
      "Claude Code: Tool server to update · 4 skills to add — Codex: Not found on this Mac",
    );
    act(() => rendered?.root.unmount());

    rendered = render(<AgentsView api={api} />, "fr");
    await act(async () => await Promise.resolve());
    expect(rendered.container.textContent).toContain(
      "Claude Code : Serveur d’outils à mettre à jour · 4 skills à ajouter — Codex : Introuvable sur ce Mac",
    );
  });
});
