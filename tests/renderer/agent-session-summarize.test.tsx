// @vitest-environment jsdom
//
// Summarize's hook on the Task card (Brief 35a): a "Doing: …" line that appears only when the
// command returns a sentence. With the `none` provider (or no `runInferenceCommand` at all) the
// card renders exactly as it does without the intelligence layer — this is the "no visual
// change" assertion the brief asks for on this hook point.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSessionView } from "../../src/renderer/activity/AgentSessionView";
import { I18nProvider } from "../../src/renderer/i18n";
import type { ActivitySnapshot } from "../../src/shared/activity-ipc";
import type { DesktopApi } from "../../src/shared/ipc";

const now = Date.parse("2026-09-14T12:00:00.000Z");

const snapshotWithActivity: ActivitySnapshot = {
  sessions: [
    {
      id: "session-alpha",
      harness: "codex",
      pid: 101,
      entrypoint: "exec",
      name: "alpha",
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
      activity: { firstPrompt: "Implement the summarize hook.", turns: 3 },
    },
  ],
  processes: [],
  worktrees: [],
  platformSupported: true,
};

function render(element: ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(<I18nProvider initialLanguage="en">{element}</I18nProvider>));
  return { container, root };
}

describe("AgentSessionView — Summarize's Doing line", () => {
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

  it("shows no Doing line when there is no runInferenceCommand at all (today's behavior)", async () => {
    const api = {
      getActivitySnapshot: vi.fn().mockResolvedValue({ status: "ready", snapshot: snapshotWithActivity }),
    } as unknown as DesktopApi;
    rendered = render(<AgentSessionView api={api} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(rendered.container.querySelector("[data-testid='activity-task-doing']")).toBeNull();
  });

  it("shows no Doing line when the command reports unavailable (the none provider)", async () => {
    const api = {
      getActivitySnapshot: vi.fn().mockResolvedValue({ status: "ready", snapshot: snapshotWithActivity }),
      runInferenceCommand: vi.fn().mockResolvedValue({ command: "summarize", intelligence: "unavailable" }),
    } as unknown as DesktopApi;
    rendered = render(<AgentSessionView api={api} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rendered.container.querySelector("[data-testid='activity-task-doing']")).toBeNull();
  });

  it("shows the Doing line once the command returns a sentence", async () => {
    const api = {
      getActivitySnapshot: vi.fn().mockResolvedValue({ status: "ready", snapshot: snapshotWithActivity }),
      runInferenceCommand: vi
        .fn()
        .mockResolvedValue({ command: "summarize", intelligence: "ok", sentence: "Wiring the summarize hook." }),
    } as unknown as DesktopApi;
    rendered = render(<AgentSessionView api={api} sessionId="session-alpha" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const doing = rendered.container.querySelector("[data-testid='activity-task-doing']");
    expect(doing?.textContent).toContain("Doing: Wiring the summarize hook.");
  });
});
