// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentsView } from "../../src/renderer/activity/AgentsView";
import { I18nProvider } from "../../src/renderer/i18n";
import type { ActivitySnapshot } from "../../src/shared/activity-ipc";

const job = {
  jobId: "job-one",
  job: "compose" as const,
  projectId: "project-one",
  startedAt: Date.now(),
  status: "running" as const,
  doing: "Reading project conventions",
  turns: 2,
  toolCalls: 2,
  tokens: { input: 10, output: 5 },
  context: { estimate: 12_000, window: 200_000 },
  costUsd: 0.03,
  requestIds: [],
};
const snapshot: ActivitySnapshot = {
  sessions: [
    {
      id: "omni:job-one",
      harness: "omni",
      pid: 0,
      entrypoint: "app",
      name: "Compose · Project",
      cwd: "/",
      projectId: "project-one",
      startedAt: job.startedAt,
      link: "process-only",
      processPids: [],
      worktreeIds: [],
      totals: { cpuPercent: 0, rssMb: 0 },
      flags: [],
      job,
      activity: { latestPrompt: job.doing },
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

describe("Activity compose jobs", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
  });

  it("shows the Omni job, Doing text, usage, and Stop action", async () => {
    const stopAgentJob = vi.fn(async () => ({ status: "stopping" as const }));
    rendered = render(
      <AgentsView
        api={
          {
            getActivitySnapshot: async () => ({ status: "ready", snapshot }),
            getAgentStatus: async () => ({
              socketPath: "socket",
              tokenCreatedAt: "2026-01-01T00:00:00.000Z",
              counts: { pending: 0, today: 0, total: 0 },
              harnesses: [],
            }),
            stopAgentJob,
          } as never
        }
      />,
    );
    await act(async () => Promise.resolve());
    expect(rendered.container.textContent).toContain("Compose · Project");
    expect(rendered.container.textContent).toContain("Reading project conventions");
    expect(rendered.container.textContent).toContain("15 tokens");
    expect(rendered.container.textContent).toContain("~12 k / 200 k");
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='activity-job-stop-job-one']")?.click(),
    );
    expect(stopAgentJob).toHaveBeenCalledWith({ jobId: "job-one" });
  });
});
