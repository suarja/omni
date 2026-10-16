// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionView } from "../../src/renderer/activity/AgentSessionView";
import { AgentsView } from "../../src/renderer/activity/AgentsView";
import { AgentActivityOverview } from "../../src/renderer/activity/AgentActivityOverview";
import { WorktreesView } from "../../src/renderer/activity/WorktreesView";
import { I18nProvider } from "../../src/renderer/i18n";
import { FeaturesProvider } from "../../src/renderer/features";
import type { ActivitySnapshot } from "../../src/shared/activity-ipc";
import type { DesktopApi } from "../../src/shared/ipc";
import { DEFAULT_FEATURES } from "../../src/shared/settings-ipc";
const now = Date.parse("2026-09-14T12:00:00.000Z");
const snapshot: ActivitySnapshot = {
  sessions: [
    {
      id: "session-alpha",
      harness: "codex",
      pid: 101,
      entrypoint: "exec",
      name: "alpha",
      task: "Run tests for the activity brief",
      cwd: "/work/acme-web",
      projectId: "project-acme-web",
      projectName: "acme-web",
      branch: "main",
      startedAt: now - 3_600_000,
      lastActivityAt: now - 60_000,
      link: "rollout-match",
      processPids: [101, 102, 103],
      worktreeIds: ["project-acme-web/.worktrees/alpha"],
      totals: { cpuPercent: 12, rssMb: 256 },
      flags: ["runaway"],
    },
    {
      id: "session-beta",
      harness: "claude-code",
      pid: 201,
      entrypoint: "desktop",
      name: "beta",
      cwd: "/work/sample-events",
      projectId: "project-sample-events",
      projectName: "sample-events",
      branch: "main",
      startedAt: now - 7_200_000,
      lastActivityAt: now - 120_000,
      link: "session-file",
      processPids: [201],
      worktreeIds: [],
      totals: { cpuPercent: 2, rssMb: 1_800 },
      flags: [],
    },
    {
      id: "session-process-only",
      harness: "codex",
      pid: 301,
      entrypoint: "terminal",
      name: "terminal task",
      cwd: "/tmp/task",
      startedAt: now - 600_000,
      link: "process-only",
      processPids: [301],
      worktreeIds: [],
      totals: { cpuPercent: 4, rssMb: 80 },
      flags: [],
    },
  ],
  processes: [
    {
      pid: 101,
      ppid: 1,
      agent: "codex",
      name: "Codex agent",
      command: "codex exec activity brief",
      sessionId: "session-alpha",
      cpuPercent: 12,
      elapsedSeconds: 7_200,
      rssMb: 256,
      depth: 0,
      flags: ["runaway"],
    },
    {
      pid: 102,
      ppid: 101,
      agent: "codex",
      name: "vitest workers",
      command: "node vitest --run",
      sessionId: "session-alpha",
      cpuPercent: 90,
      elapsedSeconds: 300,
      rssMb: 1_800,
      depth: 1,
      flags: ["duplicate"],
    },
    {
      pid: 103,
      ppid: 102,
      agent: "codex",
      name: "TypeScript check",
      command: "tsc --noEmit",
      sessionId: "session-alpha",
      cpuPercent: 4,
      elapsedSeconds: 90,
      rssMb: 120,
      depth: 2,
      flags: [],
    },
    {
      pid: 201,
      ppid: 1,
      agent: "claude-code",
      name: "Claude Code session",
      command: "claude --output-format stream-json",
      sessionId: "session-beta",
      cpuPercent: 2,
      elapsedSeconds: 3_600,
      rssMb: 1_800,
      depth: 0,
      flags: [],
    },
    {
      pid: 301,
      ppid: 1,
      agent: "codex",
      name: "Codex terminal",
      command: "codex exec detached task",
      sessionId: "session-process-only",
      cpuPercent: 4,
      elapsedSeconds: 600,
      rssMb: 80,
      depth: 0,
      flags: [],
    },
    {
      pid: 401,
      ppid: 1,
      agent: "codex",
      name: "Codex app",
      command: "codex app-server",
      cpuPercent: 1,
      elapsedSeconds: 1_000,
      rssMb: 90,
      depth: 0,
      flags: [],
    },
  ],
  worktrees: [
    {
      projectId: "project-acme-web",
      projectName: "acme-web",
      id: "main",
      branch: "main",
      kind: "git-worktree",
      dirty: false,
      ageDays: 30,
      lastActivityDays: 1,
      isMain: true,
    },
    {
      projectId: "project-acme-web",
      projectName: "acme-web",
      id: [".worktrees", "alpha"].join("/"),
      branch: "feat/alpha",
      kind: "git-worktree",
      dirty: false,
      ageDays: 10,
      lastActivityDays: 20,
      isMain: false,
      sessionId: "session-alpha",
    },
    {
      projectId: "project-acme-web",
      projectName: "acme-web",
      id: [".worktrees", "dirty"].join("/"),
      branch: "feat/dirty",
      kind: "folder",
      dirty: true,
      ageDays: 1,
      lastActivityDays: 1,
      isMain: false,
      sessionId: "session-beta",
    },
    {
      projectId: "project-sample-events",
      projectName: "sample-events",
      id: "main",
      branch: "main",
      kind: "git-worktree",
      dirty: false,
      ageDays: 2,
      lastActivityDays: 2,
      isMain: true,
    },
  ],
  platformSupported: true,
};
function apiFor(current: ActivitySnapshot = snapshot): DesktopApi {
  return {
    getActivitySnapshot: vi.fn().mockResolvedValue({ status: "ready", snapshot: current }),
    previewActivity: vi.fn(),
    applyActivity: vi.fn(),
    simulateActivity: vi.fn(),
  } as unknown as DesktopApi;
}
const activityAgentsFeatures = {
  features: { ...DEFAULT_FEATURES, activityAgents: true },
  setFeatures: () => undefined,
};

function render(element: ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() =>
    root.render(
      <I18nProvider initialLanguage="en">
        <FeaturesProvider value={activityAgentsFeatures}>{element}</FeaturesProvider>
      </I18nProvider>,
    ),
  );
  return { container, root };
}
describe("Activity pages", () => {
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
  it("renders root tile counts and only the runaway exception badge", async () => {
    rendered = render(<AgentActivityOverview api={apiFor()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='activity-tile-agents']")?.textContent).toContain(
      "3 sessions · 6 processes",
    );
    expect(rendered.container.querySelector("[data-testid='activity-tile-agents']")?.textContent).toContain(
      "1 runaway",
    );
    expect(rendered.container.querySelector("[data-testid='activity-tile-worktrees']")?.textContent).toContain(
      "2 projects · 4 checkouts",
    );
    expect(rendered.container.querySelector("[data-testid='activity-tile-worktrees']")?.textContent).toContain(
      "1 stale",
    );
    expect(rendered.container.querySelectorAll("hr, .ui-divider")).toHaveLength(0);
  });
  it("says why the snapshot is unavailable instead of loading forever", async () => {
    const api = apiFor();
    vi.mocked(api.getActivitySnapshot!).mockRejectedValue(new Error("Process full command is too long."));
    rendered = render(<AgentActivityOverview api={api} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='activity-unavailable']")?.textContent).toContain(
      "Process full command is too long.",
    );
    expect(rendered.container.querySelector("[data-testid='activity-tile-agents']")?.textContent).toContain(
      "Unavailable",
    );
    expect(rendered.container.textContent).not.toContain("Loading…");
  });
  it("orders linked sessions before process-only sessions and hosts", async () => {
    rendered = render(<AgentsView api={apiFor()} />);
    await act(async () => {
      await Promise.resolve();
    });
    const items = [...rendered.container.querySelectorAll<HTMLElement>("[data-testid^='activity-agent-item-']")];
    // Row name is now harness · project · branch (D1); the slug moves to the sub line.
    expect(items.map((item) => item.querySelector(".ui-item__name")?.firstChild?.textContent)).toEqual([
      "Codex · acme-web · main",
      "Claude Code · sample-events · main",
      "Codex",
      "Codex app",
    ]);
    expect(items[0]?.querySelector(".ui-item__sub")?.textContent).toContain("alpha");
  });

  it("searches by process PID and session task", async () => {
    rendered = render(<AgentsView api={apiFor()} />);
    await act(async () => {
      await Promise.resolve();
    });
    const search = rendered.container.querySelector<HTMLInputElement>("input[type='search']");
    expect(search).not.toBeNull();
    const setSearch = (value: string): void => {
      if (!search) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, value);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    };
    act(() => setSearch("102"));
    expect(rendered.container.textContent).toContain("alpha");
    expect(rendered.container.textContent).not.toContain("terminal task");
    act(() => setSearch("activity brief"));
    expect(rendered.container.textContent).toContain("alpha");
  });
  it("sorts agents by memory using the true subtree total, not the session's own cached totals", async () => {
    rendered = render(<AgentsView api={apiFor()} />);
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      [...(rendered?.container.querySelectorAll<HTMLButtonElement>(".ui-segmented-control__item") ?? [])]
        .find((button) => button.textContent === "Memory")
        ?.click();
    });
    const items = [...rendered.container.querySelectorAll<HTMLElement>("[data-testid^='activity-agent-item-']")];
    // session-alpha's own `totals.rssMb` field (256) is deliberately stale in this fixture; its
    // real subtree (101 + 102 + 103 = 256 + 1800 + 120 = 2176 MB) outweighs session-beta's 1800,
    // so the subtree-based sort (D3) ranks alpha first even though the cached field would not.
    expect(items[0]?.textContent).toContain("alpha");
    expect(items[0]?.textContent).toContain("2.1 GB");
  });
  it("renders a process tree and completes the stop preview flow", async () => {
    const api = apiFor();
    const previewActivity = vi.mocked(api.previewActivity!);
    const applyActivity = vi.mocked(api.applyActivity!);
    previewActivity.mockResolvedValue({
      status: "ready",
      plan: {
        planId: "plan-stop",
        kind: "stop-process",
        displayTarget: "vitest workers",
        actions: [{ pid: 102, command: "node vitest --run", cpuPercent: 90 }],
      },
    });
    applyActivity.mockResolvedValue({
      status: "applied",
      receipt: {
        operationId: "receipt-stop",
        kind: "stop-process",
        status: "applied",
        appliedAt: "2026-09-14T12:00:00.000Z",
        displayTarget: "vitest workers",
        actions: [],
        git: { mode: "unavailable" },
        registered: null,
      },
    });
    rendered = render(<AgentSessionView api={api} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Codex agent");
    expect(rendered.container.textContent).toContain("vitest workers");
    expect(rendered.container.textContent).toContain("TypeScript check");
    expect(rendered.container.querySelector("[data-testid='activity-process-103']")).not.toBeNull();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-process-102']")?.click());
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-actions-session-alpha']")?.click(),
    );
    act(() => {
      [...(rendered?.container.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])]
        .find((button) => button.textContent === "Stop")
        ?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(previewActivity).toHaveBeenCalledWith({ kind: "stop-process", pid: 102 });
    expect(rendered.container.textContent).toContain("What will be stopped");
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-confirm-stop']")?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(applyActivity).toHaveBeenCalledWith({ planId: "plan-stop" });
    expect(rendered.container.textContent).toContain("Process stopped");
  });
  it("shows an ended session and disables its head actions", async () => {
    const api = apiFor();
    const getActivitySnapshot = vi.mocked(api.getActivitySnapshot!);
    getActivitySnapshot.mockResolvedValueOnce({ status: "ready", snapshot });
    getActivitySnapshot.mockResolvedValue({
      status: "ready",
      snapshot: { sessions: [], processes: [], worktrees: [], platformSupported: true },
    });
    vi.useFakeTimers();
    rendered = render(<AgentSessionView api={api} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(rendered.container.textContent).toContain("This session has ended");
    expect(
      rendered.container.querySelector<HTMLButtonElement>("[data-testid='activity-actions-session-alpha']")?.disabled,
    ).toBe(true);
  });
  it("groups worktrees under the main checkout and removes a selected clean worktree", async () => {
    const api = apiFor();
    const previewActivity = vi.mocked(api.previewActivity!);
    const applyActivity = vi.mocked(api.applyActivity!);
    previewActivity.mockResolvedValue({
      status: "ready",
      plan: {
        planId: "plan-remove",
        kind: "remove-worktree",
        displayTarget: [".worktrees", "alpha"].join("/"),
        actions: [
          { projectId: "project-acme-web", worktreeId: [".worktrees", "alpha"].join("/"), kind: "git-worktree" },
        ],
      },
    });
    applyActivity.mockResolvedValue({
      status: "applied",
      receipt: {
        operationId: "receipt-remove",
        kind: "remove-worktree",
        status: "applied",
        appliedAt: "2026-09-14T12:00:00.000Z",
        displayTarget: [".worktrees", "alpha"].join("/"),
        actions: [],
        git: { mode: "unavailable" },
        registered: null,
      },
    });
    rendered = render(<WorktreesView api={api} projectId="project-acme-web" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='activity-worktree-main']")?.className).toContain(
      "ui-item--dim",
    );
    expect(rendered.container.textContent).toContain("feat/alpha");
    expect(rendered.container.textContent).toContain("alpha");
    act(() =>
      rendered?.container
        .querySelector<HTMLButtonElement>("[data-testid='activity-worktree-.worktrees/alpha']")
        ?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-remove-worktree']")?.click(),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(previewActivity).toHaveBeenCalledWith({
      kind: "remove-worktree",
      projectId: "project-acme-web",
      worktreeId: [".worktrees", "alpha"].join("/"),
    });
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-confirm-remove']")?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(applyActivity).toHaveBeenCalledWith({ planId: "plan-remove" });
    expect(rendered.container.textContent).toContain("Worktree removed");
    expect(rendered.container.querySelectorAll("hr, .ui-divider")).toHaveLength(0);
  });
});
