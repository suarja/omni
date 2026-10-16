// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AssignmentWorkbench } from "../../src/renderer/canvas/changes/AssignmentWorkbench";
import { I18nProvider } from "../../src/renderer/i18n";
import type { DesktopApi } from "../../src/shared/ipc";

it("reopens an assignment request through the main refresher and explains its changed effects", async () => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const source = {
    ref: { kind: "source" as const, id: "personal" },
    displayName: "Personal",
    displayRoot: "personal",
    availability: "available" as const,
    ownership: "personal" as const,
    capabilities: { observe: true as const, write: false as const },
  };
  const project = {
    ref: { kind: "project" as const, id: "project-one" },
    displayName: "Project",
    displayRoot: "project",
    availability: "available" as const,
  };
  const projectPlan = {
    projectId: "project-one",
    planId: "new-plan",
    status: "ready",
    actions: [
      {
        bindingId: "binding-one",
        kind: "skill",
        harnessId: "codex",
        relativePath: ".agents/skills/review",
        state: "add",
      },
    ],
  };
  const request = {
    requestId: "assignment-one",
    approval: "omni",
    status: "pending",
    createdAt: "2026-10-11T00:00:00Z",
    request: {
      kind: "assign",
      sourceId: "personal",
      packageId: "tools",
      artifactPath: "skills/review",
      projectIds: ["project-one"],
    },
    plan: { kind: "assign", plans: [] },
  };
  const refreshAgentRequest = vi.fn(async () => ({ ...request, plan: { kind: "assign", plans: [projectPlan] } }));
  const api = {
    listAgentRequests: vi.fn(async () => ({ requests: [request] })),
    refreshAgentRequest,
    previewBindings: vi.fn(async () => ({ status: "ready", plans: [projectPlan], units: [] })),
  } as unknown as DesktopApi;
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <AssignmentWorkbench
            api={api}
            source={source}
            projects={[project]}
            packageId="tools"
            packageName="Tools"
            artifactPath="skills/review"
            requestId="assignment-one"
            onEnsureGrant={async () => "grant"}
            onNavigate={vi.fn()}
            returnTo={{ screen: "review" }}
          />
        </I18nProvider>,
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(refreshAgentRequest).toHaveBeenCalledWith("assignment-one");
    expect(container.textContent).toContain("Files changed since the agent asked");
    expect(container.querySelector<HTMLInputElement>("[data-testid='assignment-harness-codex']")?.checked).toBe(true);
    expect(container.querySelector<HTMLButtonElement>("[data-testid='assignment-apply-now']")?.disabled).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  }
});
