// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { snapshot, resourceFixture } from "../fixtures/resource-catalogue";
import { I18nProvider } from "../../src/renderer/i18n";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { AssignmentTargets } from "../../src/renderer/canvas/changes/AssignmentTargets";
import type { Route } from "../../src/renderer/navigation";
import type { WriteSkillRequest } from "../../src/shared/operations-write-skill-ipc";
import type { SkillIntent, SkillPreview, SkillResult } from "../../src/shared/skill-management-ipc";

const request: WriteSkillRequest = {
  kind: "write-skill",
  sourceId: "source-one",
  packageId: "plugins/pstack",
  mode: "create",
  folderName: "release-notes",
  files: [
    { path: "SKILL.md", content: "# Release notes\n\nWrite a concise summary." },
    { path: "references/rules.md", content: "Use dated headings." },
  ],
};
const plan = {
  planId: "plan-one",
  kind: "write-skill" as const,
  displayTarget: "plugins/pstack",
  actions: [
    {
      kind: "write-file" as const,
      relativePath: "plugins/pstack/skills/release-notes/SKILL.md",
      afterHash: "a".repeat(64),
      diff: "@@ -0,0 +1 @@\n+# Release notes",
    },
    {
      kind: "write-file" as const,
      relativePath: "plugins/pstack/skills/release-notes/references/rules.md",
      afterHash: "c".repeat(64),
    },
  ],
  git: { mode: "unavailable" as const, warnings: [] },
};
const readyPreview: SkillPreview = {
  status: "ready",
  intentId: "intent-one",
  planId: "plan-one",
  effectFingerprint: "b".repeat(64),
  scope: { sourceId: "source-one", packageId: "plugins/pstack", targets: [] },
  steps: [
    {
      stepId: "step-one",
      scope: { sourceId: "source-one", packageId: "plugins/pstack", targets: [] },
      plan,
      bindingEffects: [],
      files: [
        {
          rootId: "source-one",
          relativePath: "plugins/pstack/skills/release-notes/SKILL.md",
          change: "add",
          afterHash: "a".repeat(64),
          diff: "@@ -0,0 +1 @@\n+# Release notes",
        },
        {
          rootId: "source-one",
          relativePath: "plugins/pstack/skills/release-notes/references/rules.md",
          change: "add",
          afterHash: "c".repeat(64),
        },
      ],
    },
  ],
};
const appliedResult: SkillResult = {
  intentId: "intent-one",
  operationId: "intent-one",
  status: "applied",
  source: { status: "created", sourceId: "source-one" },
  targets: [],
  receiptIds: ["receipt-one"],
  receipts: [
    {
      operationId: "receipt-one",
      kind: "write-skill",
      status: "applied",
      appliedAt: "2026-10-07T10:00:00.000Z",
      displayTarget: "plugins/pstack",
      actions: [],
      git: { mode: "unavailable" },
      registered: { sourceId: "source-one" },
    },
  ],
  issues: [],
  recoveryAvailable: true,
};

describe("canvas skill Changes workbench", () => {
  let root: Root;
  let container: HTMLDivElement;
  let onNavigate: ReturnType<typeof vi.fn<(route: Route) => void>>;
  let api: {
    previewSkillOperation: ReturnType<typeof vi.fn>;
    refreshSkillOperation: ReturnType<typeof vi.fn>;
    applySkillOperation: ReturnType<typeof vi.fn>;
    readSkillOperationResult: ReturnType<typeof vi.fn>;
    refreshAgentRequest: ReturnType<typeof vi.fn>;
    listAgentRequests?: ReturnType<typeof vi.fn>;
    declineAgentRequest?: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    onNavigate = vi.fn();
    api = {
      refreshAgentRequest: vi
        .fn()
        .mockResolvedValue({ intentId: "updated-intent", skillIntent: { kind: "write", request } }),
      previewSkillOperation: vi.fn().mockResolvedValue(readyPreview),
      refreshSkillOperation: vi.fn().mockResolvedValue(readyPreview),
      applySkillOperation: vi.fn().mockResolvedValue(appliedResult),
      readSkillOperationResult: vi.fn().mockResolvedValue(appliedResult),
    };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => act(() => root.unmount()));

  function render(
    props: Readonly<{
      strict?: boolean;
      initialSkillRequest?: WriteSkillRequest;
      initialSkillIntent?: SkillIntent;
      initialSkillIntentId?: string;
      initialSkillRestoreOperationId?: string;
      initialSkillResultId?: string;
      requestId?: string;
      context?: { kind: "entry"; entry: typeof resourceFixture.sourceRef | typeof resourceFixture.projectOneRef };
    }> = {},
  ): void {
    const Wrapper = props.strict ? StrictMode : ({ children }: { children: React.ReactNode }) => children;
    act(() =>
      root.render(
        <Wrapper>
          <I18nProvider initialLanguage="en">
            <ResourceCanvas
              api={api}
              context={props.context ?? { kind: "entry", entry: resourceFixture.sourceRef }}
              initialSkillRequest={props.initialSkillRequest}
              initialSkillIntent={props.initialSkillIntent}
              initialSkillIntentId={props.initialSkillIntentId}
              initialSkillRestoreOperationId={props.initialSkillRestoreOperationId}
              initialSkillResultId={props.initialSkillResultId}
              requestId={props.requestId}
              onEnsureGrant={vi.fn(async () => "grant")}
              onNavigate={onNavigate}
              onNavigateDestination={vi.fn()}
              onRefresh={vi.fn()}
              snapshot={snapshot}
            />
          </I18nProvider>
        </Wrapper>,
      ),
    );
  }

  it("opens an incoming request in the accepted canvas and previews its complete files", async () => {
    await act(async () => render({ initialSkillRequest: request, requestId: "request-one" }));

    expect(container.querySelector("[data-testid='resource-canvas']")).not.toBeNull();
    expect(container.querySelector("[data-testid='changes-workbench']")).not.toBeNull();
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "write", request },
      requestId: "request-one",
    });
  });

  it("keeps the approval reason visible when a managed request opens in the workbench", async () => {
    api.listAgentRequests = vi.fn().mockResolvedValue({
      requests: [
        {
          requestId: "managed-request-one",
          status: "pending",
          approval: "omni",
          createdAt: new Date().toISOString(),
          harness: "codex",
          request: { kind: "remove-skill", bindingIds: ["binding-one"] },
          intentId: "managed-intent-one",
          skillIntent: { kind: "remove", bindingIds: ["binding-one"] },
          plan: {
            kind: "remove-binding",
            planId: "remove-plan",
            displayTarget: "Review",
            actions: [],
            git: { mode: "unavailable", warnings: [] },
          },
          approvalReason: { code: "deletes-files", count: 2 },
        },
      ],
    });
    api.declineAgentRequest = vi.fn();
    await act(async () =>
      render({
        initialSkillIntent: { kind: "remove", bindingIds: ["binding-one"] },
        initialSkillIntentId: "managed-intent-one",
        requestId: "managed-request-one",
      }),
    );
    expect(container.querySelector('[data-testid="changes-workbench"]')?.textContent).toContain("Deletes 2 files");
  });

  it("resumes the saved managed request instead of creating a second operation", async () => {
    await act(async () =>
      render({
        initialSkillIntent: { kind: "remove", bindingIds: ["binding-one"] },
        initialSkillIntentId: "managed-intent-one",
        requestId: "managed-request-one",
        context: { kind: "entry", entry: resourceFixture.projectOneRef },
      }),
    );

    expect(api.refreshSkillOperation).toHaveBeenCalledWith({
      intentId: "managed-intent-one",
      requestId: "managed-request-one",
    });
    expect(api.previewSkillOperation).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='changes-workbench']")?.textContent).toContain("Review removal");
  });

  it("recomputes an agent request without a saved preview and keeps its approval identity", async () => {
    const updated = { ...readyPreview, intentId: "updated-intent" };
    api.refreshSkillOperation.mockResolvedValue(updated);
    await act(async () =>
      render({ initialSkillIntent: { kind: "remove", bindingIds: ["binding-one"] }, requestId: "managed-request-one" }),
    );
    expect(api.refreshAgentRequest).toHaveBeenCalledWith("managed-request-one");
    expect(api.refreshSkillOperation).toHaveBeenCalledWith({
      intentId: "updated-intent",
      requestId: "managed-request-one",
    });
    expect(api.previewSkillOperation).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>(".changes-actions .changes-primary")?.click());
    expect(api.applySkillOperation).toHaveBeenCalledWith({
      intentId: "updated-intent",
      effectFingerprint: readyPreview.effectFingerprint,
      requestId: "managed-request-one",
    });
  });

  it.each(["gone", "stale"])(
    "recomputes a %s agent preview, shows the updated diff and approves the original request",
    async (state) => {
      const updated = { ...readyPreview, intentId: "updated-intent", effectFingerprint: "d".repeat(64) };
      api.refreshSkillOperation
        .mockResolvedValueOnce({
          status: state === "gone" ? "blocked" : "stale",
          intentId: "old-intent",
          reason: "Unavailable",
          details: [{ code: "intent-unavailable", message: "Unavailable", recovery: "refresh" }],
        })
        .mockResolvedValue(updated);
      await act(async () =>
        render({
          initialSkillIntent: { kind: "write", request },
          initialSkillIntentId: "old-intent",
          requestId: "request-one",
        }),
      );
      expect(api.refreshAgentRequest).toHaveBeenCalledWith("request-one");
      expect(container.querySelector("[role=alert]")?.textContent).toContain(
        "Files changed since the agent asked. Review the updated change.",
      );
      expect(container.querySelector("[data-testid='changes-diff']")).not.toBeNull();
      expect(api.applySkillOperation).not.toHaveBeenCalled();
      await act(async () => container.querySelector<HTMLButtonElement>(".changes-actions .changes-primary")?.click());
      expect(api.applySkillOperation).toHaveBeenCalledWith({
        intentId: "updated-intent",
        effectFingerprint: "d".repeat(64),
        requestId: "request-one",
      });
    },
  );

  it("opens a stale request under StrictMode once and applies its current intent", async () => {
    let linked = "old-intent";
    const updated = { ...readyPreview, intentId: "updated-intent", effectFingerprint: "d".repeat(64) };
    api.refreshSkillOperation.mockImplementation(async ({ intentId }) => {
      if (intentId !== linked) throw new Error("Agent request does not match this skill operation.");
      return intentId === "old-intent" ? { status: "stale", intentId, reason: "Files changed", details: [] } : updated;
    });
    api.refreshAgentRequest.mockImplementation(async () => {
      linked = "updated-intent";
      return { intentId: linked, skillIntent: { kind: "write", request } };
    });
    await act(async () =>
      render({
        strict: true,
        initialSkillIntent: { kind: "write", request },
        initialSkillIntentId: "old-intent",
        requestId: "request-one",
      }),
    );
    expect(api.refreshAgentRequest).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Files changed since the agent asked");
    await act(async () => container.querySelector<HTMLButtonElement>(".changes-actions .changes-primary")?.click());
    expect(api.applySkillOperation).toHaveBeenCalledWith({
      intentId: linked,
      effectFingerprint: updated.effectFingerprint,
      requestId: "request-one",
    });
  });

  it("recovers a relink between apply preflight and apply without writing an unseen preview", async () => {
    await act(async () =>
      render({
        initialSkillIntent: { kind: "write", request },
        initialSkillIntentId: "intent-one",
        requestId: "request-one",
      }),
    );
    api.applySkillOperation.mockRejectedValueOnce(
      new Error("Agent skill request is unavailable or does not match this operation."),
    );
    api.refreshSkillOperation
      .mockResolvedValueOnce(readyPreview)
      .mockResolvedValue({ ...readyPreview, intentId: "updated-intent" });
    await act(async () => container.querySelector<HTMLButtonElement>(".changes-actions .changes-primary")?.click());
    expect(api.refreshAgentRequest).toHaveBeenCalledTimes(1);
    expect(api.applySkillOperation).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Files changed since the agent asked");
    await act(async () => container.querySelector<HTMLButtonElement>(".changes-actions .changes-primary")?.click());
    expect(api.applySkillOperation).toHaveBeenLastCalledWith({
      intentId: "updated-intent",
      effectFingerprint: readyPreview.effectFingerprint,
      requestId: "request-one",
    });
    expect(api.refreshAgentRequest).toHaveBeenCalledTimes(1);
  });

  it("requires another approval when files change while a request is open", async () => {
    await act(async () =>
      render({
        initialSkillIntent: { kind: "write", request },
        initialSkillIntentId: "intent-one",
        requestId: "request-one",
      }),
    );
    api.refreshSkillOperation
      .mockResolvedValueOnce({ status: "stale", intentId: "intent-one", reason: "Files changed", details: [] })
      .mockResolvedValue({ ...readyPreview, intentId: "updated-intent" });
    await act(async () => container.querySelector<HTMLButtonElement>(".changes-actions .changes-primary")?.click());
    expect(api.refreshAgentRequest).toHaveBeenCalledWith("request-one");
    expect(api.applySkillOperation).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Files changed since the agent asked");
  });

  it("previews an incoming adoption intent that does not have a saved operation id", async () => {
    const intent: SkillIntent = {
      kind: "reconcile",
      request: {
        choice: "adopt-exact",
        skillId: "123e4567-e89b-42d3-a456-426614174000",
        source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/review" },
        locations: [{ projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/review" }],
      },
    };
    await act(async () => render({ initialSkillIntent: intent }));

    expect(api.previewSkillOperation).toHaveBeenCalledWith({ intent });
    expect(api.refreshSkillOperation).not.toHaveBeenCalled();
  });

  it("labels project assignment as assignment rather than a source write", async () => {
    await act(async () =>
      render({
        initialSkillIntent: {
          kind: "assign",
          sourceId: "source-one",
          packageId: "plugins/pstack",
          targets: [{ projectId: "project-one", harnessIds: ["codex"] }],
        },
        initialSkillIntentId: "assign-intent",
      }),
    );
    expect(container.querySelector(".changes-actions .changes-primary")?.textContent).toBe("Assign selected skills");
  });

  it("reopens a project restore receipt in the Changes workbench", async () => {
    await act(async () =>
      render({
        context: { kind: "entry", entry: resourceFixture.projectOneRef },
        initialSkillRestoreOperationId: "remove-receipt-one",
      }),
    );

    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "restore", operationId: "remove-receipt-one" },
    });
    expect(container.querySelector("[data-testid='changes-workbench']")?.textContent).toContain("Review restore");
  });

  it("reviews an external draft through Diff, Targets and Result without a manual editor", async () => {
    await act(async () => render({ initialSkillRequest: request, requestId: "request-one" }));
    expect([...container.querySelectorAll("[role=tab]")].map((tab) => tab.textContent)).toEqual([
      "Diff",
      "Targets",
      "Result",
    ]);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("[data-testid='changes-diff']")).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".changes-actions .changes-primary")?.click());
    expect(api.applySkillOperation).toHaveBeenCalledWith({
      intentId: "intent-one",
      effectFingerprint: "b".repeat(64),
      requestId: "request-one",
    });
    expect(container.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Result");
    expect(container.querySelector("[data-testid='changes-result']")?.textContent).toContain(
      "Skill created in the marketplace.",
    );
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.startsWith("Review restore"))
        ?.click(),
    );
    expect(api.previewSkillOperation).toHaveBeenLastCalledWith({
      intent: { kind: "restore", operationId: "intent-one" },
    });
  });

  it("opens the new skill form from its marketplace context without writing", async () => {
    render();
    const info = [...container.querySelectorAll<HTMLButtonElement>(".canvas-node-info")].find((button) =>
      button.getAttribute("aria-label")?.includes("Personal Skills"),
    );
    act(() => info?.click());
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "New skill draft")
        ?.click(),
    );
    expect(container.querySelector("[data-testid='new-skill-sheet']")).not.toBeNull();
    expect(container.querySelector("#ns-desc")).not.toBeNull();
    expect(api.previewSkillOperation).not.toHaveBeenCalled();
  });

  it("reopens a saved result without refreshing or replaying its proposal", async () => {
    await act(async () => render({ initialSkillResultId: "intent-one" }));
    expect(api.readSkillOperationResult).toHaveBeenCalledWith({ intentId: "intent-one" });
    expect(api.previewSkillOperation).not.toHaveBeenCalled();
    expect(api.applySkillOperation).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='changes-result']")).not.toBeNull();
  });

  it("keeps the originating canvas open while the approved effect is running", async () => {
    let finish!: (result: SkillResult) => void;
    api.applySkillOperation.mockImplementation(
      () =>
        new Promise<SkillResult>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => render({ initialSkillRequest: request }));
    await act(async () => container.querySelector<HTMLButtonElement>(".changes-actions .changes-primary")?.click());
    const close = container.querySelector<HTMLButtonElement>(".changes-header button");
    expect(close?.disabled).toBe(true);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("[data-testid='changes-workbench']")).not.toBeNull();
    await act(async () => finish(appliedResult));
    expect(close?.disabled).toBe(false);
  });

  it("opens removal from a persisted project use inside the shared Changes workbench", async () => {
    render({ context: { kind: "entry", entry: resourceFixture.projectOneRef } });
    const info = [...container.querySelectorAll<HTMLButtonElement>(".canvas-node-info")].find((button) =>
      button.getAttribute("aria-label")?.includes("Project One"),
    );
    act(() => info?.click());

    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>(".canvas-secondary-button")]
        .find((button) => button.textContent === "Remove")
        ?.click(),
    );

    expect(api.previewSkillOperation).toHaveBeenCalledWith({ intent: { kind: "remove", bindingIds: ["binding-one"] } });
    expect(container.querySelector("[data-testid='changes-workbench']")?.textContent).toContain("Review removal");
  });

  it("shows unavailable harnesses without redundant available labels", () => {
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <AssignmentTargets
            sources={[{ id: "source-one", name: "Personal" }]}
            packages={[{ id: "plugins/pstack", sourceId: "source-one", name: "pstack" }]}
            artifacts={[]}
            projects={[{ id: "project-one", name: "Project One", available: true, harnesses: ["codex"] }]}
            busy={false}
            onInvalidate={vi.fn()}
            onReview={vi.fn()}
          />
        </I18nProvider>,
      ),
    );

    expect(container.textContent).not.toContain("Available");
    expect(container.textContent).toContain("Not detected");
  });

  it("starts source assignment unselected and preselects detected targets from a project", () => {
    const props = {
      sources: [{ id: "source-one", name: "Personal" }],
      packages: [{ id: "plugins/pstack", sourceId: "source-one", name: "pstack" }],
      artifacts: [],
      projects: [{ id: "project-one", name: "Project One", available: true, harnesses: ["codex" as const] }],
      busy: false,
      onInvalidate: vi.fn(),
      onReview: vi.fn(),
    };
    const renderTargets = (projectId?: string): void =>
      act(() =>
        root.render(
          <I18nProvider initialLanguage="en">
            <AssignmentTargets {...props} {...(projectId ? { projectId, packageId: "plugins/pstack" } : {})} />
          </I18nProvider>,
        ),
      );

    renderTargets();
    expect(
      [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].some((input) => input.checked),
    ).toBe(false);
    renderTargets("project-one");
    const [project, claudeCode, codex, cursor] = [
      ...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
    ];
    expect(project?.checked).toBe(true);
    expect(claudeCode?.checked).toBe(false);
    expect(codex?.checked).toBe(true);
    expect(cursor?.checked).toBe(false);
  });
});
