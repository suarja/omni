// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CatalogueAssignmentWorkbench } from "../../src/renderer/canvas/changes/CatalogueAssignmentWorkbench";
import { I18nProvider } from "../../src/renderer/i18n";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationPlan } from "../../src/shared/operations-ipc";

const plan: OperationPlan = {
  planId: "composite-plan",
  kind: "add-to-project" as const,
  displayTarget: "quality → ui → Demo",
  actions: [],
  git: { mode: "unavailable" as const, warnings: [] },
  steps: [
    {
      kind: "import" as const,
      plan: {
        planId: "import",
        kind: "import-artifact" as const,
        displayTarget: "packages/ui",
        actions: [{ kind: "write-file", relativePath: "packages/ui/skills/quality/SKILL.md", byteLength: 2048 }],
        git: { mode: "unavailable" as const, warnings: [] },
      },
    },
    {
      kind: "assign" as const,
      plan: {
        planId: "assign",
        projectId: "project-one",
        status: "ready",
        actions: [
          {
            bindingId: "binding-codex",
            harnessId: "codex",
            kind: "skill",
            relativePath: ".agents/skills/quality",
            state: "add",
          },
        ],
      },
    },
  ],
};

describe("CatalogueAssignmentWorkbench", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement | undefined;
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  it("previews both plans and applies the composite operation", async () => {
    const previewOperation = vi.fn().mockResolvedValue({ status: "ready", plan });
    const onNavigateToRoute = vi.fn();
    const applyOperation = vi.fn().mockResolvedValue({
      status: "applied",
      receipt: {
        operationId: "composite-receipt",
        kind: "add-to-project",
        status: "applied",
        appliedAt: "now",
        displayTarget: plan.displayTarget,
        actions: [],
        git: { mode: "unavailable" },
        registered: null,
        children: ["import-receipt", "apply-receipt"],
      },
    });
    const listOperations = vi.fn().mockResolvedValue({
      status: "ready",
      receipts: [
        {
          operationId: "import-receipt",
          kind: "import-artifact",
          status: "applied",
          appliedAt: "now",
          displayTarget: "packages/ui",
          actions: [],
          git: { mode: "commit", commit: "abc1234" },
          registered: { sourceId: "personal" },
        },
        {
          operationId: "apply-receipt",
          kind: "apply-plan",
          status: "applied",
          appliedAt: "now",
          displayTarget: "Demo",
          actions: [],
          git: { mode: "commit", commit: "def5678" },
          registered: null,
          project: { id: "project-one" },
        },
      ],
    });
    const observation = {
      subject: { kind: "project" as const, id: "project-one" },
      observedAt: "2026-09-14T00:00:00.000Z",
      inventory: {
        rootHandle: "project",
        displayRoot: "/tmp/Demo",
        observedAt: "2026-09-14T00:00:00.000Z",
        harnesses: ["codex"],
        artifacts: [],
        packages: [],
        diagnostics: [],
        gitScopes: [],
      },
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <I18nProvider initialLanguage="en">
          <CatalogueAssignmentWorkbench
            api={{ previewOperation, applyOperation, listOperations } as unknown as DesktopApi}
            entry={{ ownerRepo: "anthropics/skills", skill: "quality" }}
            auditReport={null}
            marketplaceObservation={{
              subject: { kind: "source", id: "personal" },
              observedAt: "2026-09-14T00:00:00.000Z",
              inventory: {
                rootHandle: "marketplace",
                displayRoot: "/tmp/marketplace",
                observedAt: "2026-09-14T00:00:00.000Z",
                harnesses: [],
                artifacts: [],
                packages: [
                  {
                    id: "packages/ui",
                    relativeRoot: "packages/ui",
                    displayName: "UI",
                    format: "omni",
                    manifestPaths: ["omni.plugin.json"],
                    artifactIds: [],
                  },
                ],
                diagnostics: [],
                gitScopes: [],
              },
            }}
            onEnsureGrant={vi.fn().mockResolvedValue("project-grant")}
            onNavigateToRoute={onNavigateToRoute}
            projectId="project-one"
            projectName="sample-mobile"
            returnTo={{ screen: "project", projectId: "project-one", tab: "overview" }}
            observations={{ "project:project-one": observation }}
          />
        </I18nProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("What will change");
    expect(container.textContent).toContain("Claude Code");
    expect(container.textContent).toContain("Codex");
    expect(
      (container.querySelector("[data-testid='add-to-project-harness-codex'] input") as HTMLInputElement)?.checked,
    ).toBe(true);
    expect(container.textContent).toContain("quality");
    expect(container.textContent).toContain(".agents/skills/quality");
    expect(container.querySelector("[data-testid='add-to-project-apply']")).not.toBeNull();
    act(() => container?.querySelector<HTMLButtonElement>("#changes-tab-targets")?.click());
    expect(container?.querySelector("[data-testid='add-to-project-apply']")?.closest("[hidden]")).toBeNull();
    act(() => (container?.querySelector("[data-testid='add-to-project-apply']") as HTMLButtonElement)?.click());
    await act(async () => await Promise.resolve());
    expect(applyOperation).toHaveBeenCalledWith({ planId: "composite-plan" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Added to sample-mobile");
    expect(container.textContent).toContain("Marketplace · commit abc1234");
    expect(container.textContent).toContain("Project · commit def5678");
    expect(container.querySelector(".changes-header")?.textContent).toContain("sample-mobile");
    act(() => (container?.querySelector("[data-testid='add-to-project-view-receipt']") as HTMLButtonElement)?.click());
    expect(onNavigateToRoute).toHaveBeenCalledWith({
      screen: "operation-receipt",
      operationId: "composite-receipt",
      returnTo: { screen: "project", projectId: "project-one", tab: "overview" },
    });
  });
});
