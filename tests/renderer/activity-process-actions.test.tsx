// @vitest-environment jsdom
//
// Renderer coverage for Brief 33c: the root row's own + subtree totals pair and the "% of one
// core" head meta (D3), the full-command sub and the Details disclosure with on-demand listening
// ports for a root (D4), and the session head's Actions menu — its five entries, Pause/Resume
// picked from the selected process's state, and its absence on an unsupported platform (D5).
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSessionView } from "../../src/renderer/activity/AgentSessionView";
import { I18nProvider } from "../../src/renderer/i18n";
import type { ActivitySnapshot } from "../../src/shared/activity-ipc";
import type { DesktopApi } from "../../src/shared/ipc";

const now = Date.parse("2026-09-14T12:00:00.000Z");

const baseSnapshot: ActivitySnapshot = {
  sessions: [
    {
      id: "session-alpha",
      harness: "codex",
      pid: 500,
      entrypoint: "exec",
      name: "alpha",
      cwd: "/work/project",
      startedAt: now - 3_600_000,
      link: "rollout-match",
      processPids: [500, 501],
      worktreeIds: [],
      totals: { cpuPercent: 1, rssMb: 100 },
      flags: [],
    },
  ],
  processes: [
    {
      pid: 500,
      ppid: 1,
      agent: "codex",
      name: "Codex agent",
      command: "codex exec --brief",
      fullCommand: "codex exec --brief --workspace /Users/example/project",
      sessionId: "session-alpha",
      cpuPercent: 1,
      elapsedSeconds: 3_600,
      rssMb: 100,
      depth: 0,
      flags: [],
      startedAt: now - 3_600_000,
      cwd: "/work/project",
      state: "sleeping",
    },
    {
      pid: 501,
      ppid: 500,
      agent: "codex",
      name: "vitest",
      command: "node vitest",
      fullCommand: "node vitest --run",
      sessionId: "session-alpha",
      cpuPercent: 24,
      elapsedSeconds: 300,
      rssMb: 350,
      depth: 1,
      flags: [],
      state: "running",
    },
  ],
  worktrees: [],
  platformSupported: true,
};

function apiFor(snapshot: ActivitySnapshot = baseSnapshot): DesktopApi {
  return {
    getActivitySnapshot: vi.fn().mockResolvedValue({ status: "ready", snapshot }),
    previewActivity: vi.fn().mockResolvedValue({ status: "blocked", reason: "test", diagnostic: "not exercised" }),
    applyActivity: vi.fn(),
    simulateActivity: vi.fn(),
    getListeningPorts: vi.fn().mockResolvedValue({ ports: [{ pid: 500, port: 3000 }] }),
    openTerminal: vi.fn().mockResolvedValue({ status: "opened" }),
  } as unknown as DesktopApi;
}

function render(element: ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(<I18nProvider initialLanguage="en">{element}</I18nProvider>));
  return { container, root };
}

function menuItemLabels(container: HTMLElement): readonly (string | null)[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")].map((button) => button.textContent);
}

function clickMenuItem(container: HTMLElement, label: string): void {
  [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
    .find((button) => button.textContent === label)
    ?.click();
}

describe("Activity iteration 3, part 2 — totals, details, and the Actions menu", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useRealTimers();
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    vi.restoreAllMocks();
  });

  it("shows the root's own values plus a subtree pair, and states '% of one core' once in the head meta", async () => {
    rendered = render(<AgentSessionView api={apiFor()} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("% of one core");
    const rootRow = rendered.container.querySelector("[data-testid='activity-process-500']");
    // Own: 1.0 % · 100 MB. Subtree (500 + 501): 25.0 % · 450 MB.
    expect(rootRow?.textContent).toContain("1.0 %");
    expect(rootRow?.textContent).toContain("subtree");
    expect(rootRow?.textContent).toContain("25.0 %");
    expect(rootRow?.textContent).toContain("450 MB");
    // The child states only its own values, no subtree pair.
    const childRow = rendered.container.querySelector("[data-testid='activity-process-501']");
    expect(childRow?.textContent).toContain("24.0 %");
    expect(childRow?.textContent).not.toContain("subtree");
  });

  it("shows the full command in the row sub, and the Details child with state, cwd, and ports fetched on demand for the root", async () => {
    const api = apiFor();
    rendered = render(<AgentSessionView api={api} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("codex exec --brief --workspace /Users/example/project");
    expect(rendered.container.querySelector("[data-testid='activity-process-details-500']")).not.toBeNull();
    expect(rendered.container.textContent).toContain("sleeping");
    expect(rendered.container.textContent).toContain("/work/project");
    expect(api.getListeningPorts).toHaveBeenCalledWith({ pids: [500] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("listens on 3000");
    // Ports are never fetched for a non-root row.
    expect(api.getListeningPorts).not.toHaveBeenCalledWith({ pids: [501] });
  });

  it("opens an Actions menu with Stop/Kill/Pause/Open in Terminal/Renice and previews the selected action", async () => {
    const api = apiFor();
    rendered = render(<AgentSessionView api={api} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-process-500']")?.click());
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-actions-session-alpha']")?.click(),
    );
    expect(menuItemLabels(rendered.container)).toEqual([
      "Stop",
      "Kill",
      "Pause",
      "Open in Terminal",
      "Lower priority (+10)",
      "Reset priority (0)",
    ]);
    act(() => clickMenuItem(rendered!.container, "Kill"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.previewActivity).toHaveBeenCalledWith({ kind: "signal-process", pid: 500, action: "kill" });
  });

  it("offers Resume instead of Pause when the selected process's state is stopped", async () => {
    const stopped: ActivitySnapshot = {
      ...baseSnapshot,
      processes: baseSnapshot.processes.map((process) =>
        process.pid === 500 ? { ...process, state: "stopped" } : process,
      ),
    };
    rendered = render(<AgentSessionView api={apiFor(stopped)} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-process-500']")?.click());
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-actions-session-alpha']")?.click(),
    );
    expect(menuItemLabels(rendered.container)).toContain("Resume");
    expect(menuItemLabels(rendered.container)).not.toContain("Pause");
  });

  it("previews Open in Terminal directly (no confirm card) and renice with the chosen priority", async () => {
    const api = apiFor();
    rendered = render(<AgentSessionView api={api} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-process-500']")?.click());
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-actions-session-alpha']")?.click(),
    );
    act(() => clickMenuItem(rendered!.container, "Open in Terminal"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.openTerminal).toHaveBeenCalledWith({ cwd: "/work/project" });
    expect(api.previewActivity).not.toHaveBeenCalled();

    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-process-500']")?.click());
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-actions-session-alpha']")?.click(),
    );
    act(() => clickMenuItem(rendered!.container, "Lower priority (+10)"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.previewActivity).toHaveBeenCalledWith({ kind: "renice-process", pid: 500, nice: 10 });
  });

  it("hides the Actions menu on an unsupported platform", async () => {
    const unsupported: ActivitySnapshot = { ...baseSnapshot, platformSupported: false };
    rendered = render(<AgentSessionView api={apiFor(unsupported)} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='activity-actions-session-alpha']")).toBeNull();
  });
});
