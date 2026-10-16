// @vitest-environment jsdom
//
// Renderer coverage for Brief 33b (Activity iteration 3, part 1): the harness · project ·
// branch row name, the title/latest-prompt/task second line with the slug in mono, the Task
// card built from `activity` evidence (rows omitted when a field is unknown, "at least N"
// turns when the tail was truncated), and the unsupported-platform line (Brief 33a's
// `platformSupported`). Split out of `activity.test.tsx` to keep both files under the
// project's preferred line-count target.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSessionView } from "../../src/renderer/activity/AgentSessionView";
import { AgentsView } from "../../src/renderer/activity/AgentsView";
import { AgentActivityOverview } from "../../src/renderer/activity/AgentActivityOverview";
import { I18nProvider } from "../../src/renderer/i18n";
import type { ActivitySnapshot } from "../../src/shared/activity-ipc";
import type { DesktopApi } from "../../src/shared/ipc";

const now = Date.parse("2026-09-14T12:00:00.000Z");

const baseSnapshot: ActivitySnapshot = {
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
      processPids: [101],
      worktreeIds: [],
      totals: { cpuPercent: 12, rssMb: 256 },
      flags: [],
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
  ],
  processes: [],
  worktrees: [],
  platformSupported: true,
};

function apiFor(snapshot: ActivitySnapshot = baseSnapshot): DesktopApi {
  return {
    getActivitySnapshot: vi.fn().mockResolvedValue({ status: "ready", snapshot }),
    previewActivity: vi.fn(),
    applyActivity: vi.fn(),
    simulateActivity: vi.fn(),
  } as unknown as DesktopApi;
}

function render(element: ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(<I18nProvider initialLanguage="en">{element}</I18nProvider>));
  return { container, root };
}

describe("Activity iteration 3 — rows, Task card, unsupported platform", () => {
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

  it("omits unknown project or branch from the row name, and shows the title when set", async () => {
    const withVariants: ActivitySnapshot = {
      ...baseSnapshot,
      sessions: [
        { ...baseSnapshot.sessions[0]!, id: "session-no-branch", branch: undefined },
        { ...baseSnapshot.sessions[1]!, id: "session-no-project", projectId: undefined, projectName: undefined },
        { ...baseSnapshot.sessions[0]!, id: "session-titled", title: "My renamed session" },
      ],
    };
    rendered = render(<AgentsView api={apiFor(withVariants)} />);
    await act(async () => {
      await Promise.resolve();
    });
    const nameOf = (id: string): string | null | undefined =>
      rendered?.container.querySelector(`[data-testid='activity-agent-item-${id}']`)?.querySelector(".ui-item__name")
        ?.firstChild?.textContent;
    expect(nameOf("session-no-branch")).toBe("Codex · acme-web");
    expect(nameOf("session-no-project")).toBe("Claude Code · main");
    const subOf = (id: string): string | null | undefined =>
      rendered?.container.querySelector(`[data-testid='activity-agent-item-${id}']`)?.querySelector(".ui-item__sub")
        ?.textContent;
    expect(subOf("session-titled")).toContain("My renamed session");
  });

  it("shows the Task card rows built from activity evidence, omitting what is unknown", async () => {
    const withActivity: ActivitySnapshot = {
      ...baseSnapshot,
      sessions: [
        {
          ...baseSnapshot.sessions[0]!,
          activity: {
            firstPrompt: "Implement the activity evidence and rows brief.",
            latestPrompt: "Also update the fixtures.",
            latestPromptAt: now - 5_000,
            lastTool: { name: "Bash", target: "git status" },
            turns: 42,
            tailTruncated: true,
            lastAnswerAt: now - 2_000,
            subagents: 0,
          },
        },
      ],
    };
    rendered = render(<AgentSessionView api={apiFor(withActivity)} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Asked first");
    expect(rendered.container.textContent).toContain("Implement the activity evidence and rows brief.");
    expect(rendered.container.textContent).toContain("Working on now");
    expect(rendered.container.textContent).toContain("Also update the fixtures.");
    expect(rendered.container.textContent).toContain("Last tool");
    expect(rendered.container.textContent).toContain("Bash · git status");
    expect(rendered.container.textContent).toContain("Turns");
    expect(rendered.container.textContent).toContain("at least 42");
    expect(rendered.container.textContent).toContain("Last answer");
    // Sub-agents is omitted when the count is zero.
    expect(rendered.container.textContent).not.toContain("Sub-agents");
  });

  it("shows the exact turn count when the tail was not truncated, and a sub-agent count above zero", async () => {
    const withActivity: ActivitySnapshot = {
      ...baseSnapshot,
      sessions: [{ ...baseSnapshot.sessions[0]!, activity: { turns: 3, tailTruncated: false, subagents: 2 } }],
    };
    rendered = render(<AgentSessionView api={apiFor(withActivity)} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Turns");
    expect(rendered.container.textContent).toContain("3");
    expect(rendered.container.textContent).not.toContain("at least");
    expect(rendered.container.textContent).toContain("Sub-agents");
    expect(rendered.container.textContent).toContain("2");
  });

  it("omits the Task card entirely when no activity evidence is known", async () => {
    rendered = render(<AgentSessionView api={apiFor()} sessionId="session-beta" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).not.toContain("Asked first");
  });

  it("shows the unsupported-platform line and hides the process simulation on an unsupported platform", async () => {
    const unsupported: ActivitySnapshot = { ...baseSnapshot, platformSupported: false };
    rendered = render(<AgentActivityOverview api={apiFor(unsupported)} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain(
      "Process observation is not available on this platform yet — sessions come from the harness files.",
    );
    act(() => rendered?.root.unmount());

    rendered = render(<AgentsView api={apiFor(unsupported)} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain(
      "Process observation is not available on this platform yet — sessions come from the harness files.",
    );
  });
});
