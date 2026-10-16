// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../src/shared/ipc";
import type { SkillPreview, SkillEffectStep, SkillIntent, SkillResult } from "../../src/shared/skill-management-ipc";
import { I18nProvider } from "../../src/renderer/i18n";
import { OperationChangesWorkbench } from "../../src/renderer/canvas/changes/OperationChangesWorkbench";
import type { WriteSkillRequest } from "../../src/shared/operations-write-skill-ipc";

const source = { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/demo" } as const;
const location = { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" } as const;

const savedResult = {
  intentId: "operation-original",
  operationId: "operation-original",
  status: "partial",
  source: { status: "updated", sourceId: source.sourceId },
  targets: [{ ...location, bindingId: "binding-one", artifactPath: location.folderPath, status: "failed" }],
  receiptIds: ["receipt-one"],
  receipts: [{ operationId: "receipt-one", kind: "propagate-skill", status: "applied", restored: false }],
  issues: [],
  recoveryAvailable: false,
  propagation: {
    mode: "update-and-maintain",
    source,
    targets: [{ location, bindingId: "binding-one", state: "eligible", result: "failed" }],
  },
} as unknown as SkillResult;

const request: WriteSkillRequest = {
  kind: "write-skill",
  sourceId: source.sourceId,
  packageId: source.packageId,
  mode: "update",
  folderName: "demo",
  files: [{ path: "SKILL.md", content: "updated" }],
};
const peer = { ...location, harnessId: "claude-code", folderPath: ".claude/skills/demo" } as const;
const intent = {
  kind: "update-and-maintain",
  source,
  request,
  locations: [location, peer],
} as const;
function readyPreview(next: SkillIntent): SkillPreview {
  const locations =
    next.kind === "update-and-maintain" || next.kind === "maintain-current" ? (next.locations ?? [location, peer]) : [];
  const safe = locations.filter((value) => value.harnessId === "codex");
  const steps = safe.map((value) => ({
    stepId: "target",
    scope: { targets: [{ projectId: value.projectId, harnessId: value.harnessId }] },
    plan: { kind: "propagate-skill", actions: [] },
    bindingEffects: [],
    propagationEvidence: { location: value },
    files: [
      {
        rootId: value.projectId,
        relativePath: `${value.folderPath}/SKILL.md`,
        change: "change",
        diff: "@@ -1 +1 @@\n-old\n+updated",
      },
      {
        rootId: value.projectId,
        relativePath: `${value.folderPath}/support.png`,
        change: "change",
        diff: `${value.folderPath}/support.png: binary content updated (12 bytes).`,
      },
    ],
  })) as unknown as SkillEffectStep[];
  return {
    status: "ready",
    intentId: "preview",
    planId: "plan",
    effectFingerprint: "a".repeat(64),
    scope: { sourceId: source.sourceId, targets: safe.map(({ projectId, harnessId }) => ({ projectId, harnessId })) },
    steps,
    ...(next.kind !== "update-and-maintain" && next.kind !== "maintain-current"
      ? {}
      : {
          propagation: {
            mode: next.kind,
            source,
            targets: locations.map((value) => ({
              location: value,
              state: value.harnessId === "codex" ? "eligible" : "retained-local",
              reason: value.harnessId === "codex" ? undefined : "Local edit",
            })),
          },
        }),
  } as SkillPreview;
}

describe("linked skill Changes workbench", () => {
  let root: Root;
  let container: HTMLDivElement;
  const api = {
    previewSkillOperation: vi
      .fn()
      .mockResolvedValue({ status: "blocked", intentId: "retry-preview", reason: "Refresh", details: [] }),
    refreshSkillOperation: vi.fn(),
    applySkillOperation: vi.fn(),
    readSkillOperationResult: vi.fn().mockResolvedValue(savedResult),
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    api.readSkillOperationResult.mockResolvedValue(savedResult);
    api.previewSkillOperation.mockImplementation(async ({ intent }: { intent: SkillIntent }) => readyPreview(intent));
  });
  afterEach(() => act(() => root.unmount()));

  it("reopens target results, exposes restore, and retries only the selected target with retryOf", async () => {
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <OperationChangesWorkbench
            api={api as unknown as DesktopApi}
            artifacts={[]}
            initialJourney="draft"
            initialResultId="operation-original"
            onClose={vi.fn()}
            onSourceChanged={vi.fn()}
            packages={[]}
            projects={[]}
            sources={[]}
          />
        </I18nProvider>,
      ),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Failed");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBeTruthy();
    expect(container.textContent).toContain("Review restore");
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='changes-propagation-retry']")?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: {
        kind: "maintain-current",
        source,
        locations: [location],
        retryOf: "operation-original",
      },
    });
  });

  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const renderPreview = async (initialSkillIntent: SkillIntent = intent): Promise<void> => {
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <OperationChangesWorkbench
            api={api as unknown as DesktopApi}
            artifacts={[{ ...source, name: "Demo skill" }]}
            initialJourney="draft"
            initialSkillIntent={initialSkillIntent}
            onClose={vi.fn()}
            onSourceChanged={vi.fn()}
            packages={[]}
            projects={[{ id: location.projectId, name: "One", available: true, harnesses: ["codex", "claude-code"] }]}
            sources={[{ id: source.sourceId, name: "Personal" }]}
          />
        </I18nProvider>,
      ),
    );
    await settle();
  };
  it("maps the skill header, real diff, binary chip and closed details into Compare", async () => {
    await renderPreview();
    expect(container.querySelector("h2")?.textContent).toBe("Demo skill");
    expect([...container.querySelectorAll('[role="tab"]')].map((item) => item.textContent)).toEqual([
      "Compare",
      "Projects",
      "Result",
    ]);
    expect(container.querySelector('select[aria-label="Project copy"]')).not.toBeNull();
    expect(container.textContent).toContain("updated");
    expect(container.querySelector("details")?.open).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('[data-propagation-file$="support.png"]')?.click());
    expect(container.textContent).toContain("Binary file updated");
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Project copy"]')!;
    act(() => {
      select.value = select.options[1].value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Local comparison unavailable");
    expect(container.querySelector(".changes-diff-line")).toBeNull();
  });
  it("shows the underlying preview error in the development detail", async () => {
    api.previewSkillOperation.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'omni:skill-management:preview': Error: The project root is unavailable.",
      ),
    );
    await renderPreview();
    expect(container.querySelector(".changes-error > p")?.textContent).toBe("The project root is unavailable.");
    expect(container.querySelector(".changes-error-details summary")?.textContent).toBe("Technical details");
    expect(container.querySelector(".changes-error-details code")?.textContent).toContain(
      "The project root is unavailable.",
    );
  });
  it("shows the actual preview message without technical details in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      api.previewSkillOperation.mockRejectedValueOnce(new Error("The project root is unavailable."));
      await renderPreview();
      expect(container.querySelector(".changes-error > p")?.textContent).toBe("The project root is unavailable.");
      expect(container.querySelector(".changes-error-details")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("keeps mixed locations visible and deselects the safe copy through a source-only preview", async () => {
    await renderPreview();
    act(() => container.querySelector<HTMLButtonElement>("#changes-tab-targets")?.click());
    expect(container.textContent).toContain("1 projects");
    expect(container.textContent).toContain("2 copies");
    expect(container.textContent).toContain("Claude Code");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    await settle();
    expect(api.previewSkillOperation).toHaveBeenLastCalledWith({ intent: { kind: "write", request } });
    expect(container.querySelector("footer")?.textContent).toContain("Marketplace only");
    expect(container.querySelector(".changes-primary")?.textContent).toBe("Update skill");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });
  it("disables maintaining a current marketplace when no safe copy is selected", async () => {
    await renderPreview({ kind: "maintain-current", source, locations: [location] });
    act(() => container.querySelector<HTMLButtonElement>("#changes-tab-targets")?.click());
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    await settle();
    expect(container.querySelector<HTMLButtonElement>(".changes-primary")?.disabled).toBe(true);
    expect(api.applySkillOperation).not.toHaveBeenCalled();
  });
  it("preserves the original result while a retry becomes a linked child", async () => {
    api.applySkillOperation.mockResolvedValue({
      ...savedResult,
      intentId: "child",
      operationId: "child",
      propagation: { ...savedResult.propagation!, retryOf: "operation-original", mode: "maintain-current" },
    });
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <OperationChangesWorkbench
            api={api as unknown as DesktopApi}
            artifacts={[]}
            initialJourney="draft"
            initialResultId="operation-original"
            onClose={vi.fn()}
            onSourceChanged={vi.fn()}
            packages={[]}
            projects={[]}
            sources={[]}
          />
        </I18nProvider>,
      ),
    );
    await settle();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="changes-propagation-retry"]')?.click());
    await settle();
    act(() => container.querySelector<HTMLButtonElement>(".changes-primary")?.click());
    await settle();
    expect(container.textContent).toContain("Retry of");
    const original = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "Open original result",
    );
    expect(original).toBeDefined();
    act(() => original?.click());
    await settle();
    expect(container.textContent).toContain("operation-original");
    expect(api.applySkillOperation).toHaveBeenCalledTimes(1);
  });

  it("reviews the inverse separately before applying Restore", async () => {
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <OperationChangesWorkbench
            api={api as unknown as DesktopApi}
            artifacts={[]}
            initialJourney="draft"
            initialResultId="operation-original"
            onClose={vi.fn()}
            onSourceChanged={vi.fn()}
            packages={[]}
            projects={[{ id: location.projectId, name: "One", available: true, harnesses: ["codex", "claude-code"] }]}
            sources={[{ id: source.sourceId, name: "Personal" }]}
          />
        </I18nProvider>,
      ),
    );
    await settle();
    const restore = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "Review restore",
    );
    act(() => restore?.click());
    await settle();
    expect(api.previewSkillOperation).toHaveBeenLastCalledWith({
      intent: { kind: "restore", operationId: "operation-original" },
    });
    expect(api.applySkillOperation).not.toHaveBeenCalled();
    expect(container.querySelector(".changes-primary")?.textContent).toBe("Restore changes");
    const cancel = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === "Keep current result",
    );
    expect(cancel).toBeDefined();
    act(() => cancel?.click());
    await settle();
    expect(container.textContent).toContain("Failed");
    expect(api.readSkillOperationResult).toHaveBeenLastCalledWith({ intentId: "operation-original" });
  });
  it("keeps propagation context and shows only inverse preview targets and files", async () => {
    const inverse = {
      ...readyPreview({ kind: "restore", operationId: "operation-original" }),
      steps: [
        {
          stepId: "inverse-source",
          scope: {
            sourceId: source.sourceId,
            packageId: source.packageId,
            artifactPath: source.artifactPath,
            targets: [],
          },
          plan: { kind: "restore-import", actions: [] },
          bindingEffects: [],
          files: [
            {
              rootId: source.sourceId,
              relativePath: `${source.packageId}/${source.artifactPath}/SKILL.md`,
              change: "change",
              diff: "@@ -1 +1 @@\n-updated marketplace\n+previous marketplace",
            },
          ],
        },
        {
          stepId: "inverse-copy",
          scope: { targets: [{ projectId: location.projectId, harnessId: location.harnessId }] },
          plan: { kind: "restore-skill", actions: [] },
          bindingEffects: [],
          propagationEvidence: { location },
          files: [
            {
              rootId: location.projectId,
              relativePath: `${location.folderPath}/SKILL.md`,
              change: "change",
              diff: "@@ -1 +1 @@\n-updated\n+old",
            },
            {
              rootId: location.projectId,
              relativePath: `${location.folderPath}/image.png`,
              change: "change",
              diff: `${location.folderPath}/image.png: binary content restored (4 bytes).`,
              byteLength: 4,
            },
          ],
        },
      ],
    } as unknown as SkillPreview;
    api.previewSkillOperation.mockImplementation(async ({ intent: next }: { intent: SkillIntent }) =>
      next.kind === "restore" ? inverse : readyPreview(next),
    );
    const original = {
      ...savedResult,
      targets: [
        { ...location, bindingId: "binding-one", artifactPath: location.folderPath, status: "applied" },
        { ...peer, bindingId: "binding-two", artifactPath: peer.folderPath, status: "unknown" },
      ],
      propagation: {
        ...savedResult.propagation!,
        targets: [
          { location, bindingId: "binding-one", state: "eligible", result: "applied" },
          {
            location: peer,
            bindingId: "binding-two",
            state: "unavailable",
            result: "unknown",
            reason: "Recovery required",
          },
        ],
      },
    } as unknown as SkillResult;
    api.readSkillOperationResult.mockResolvedValue(original);
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <OperationChangesWorkbench
            api={api as unknown as DesktopApi}
            artifacts={[]}
            initialJourney="draft"
            initialResultId="operation-original"
            onClose={vi.fn()}
            onSourceChanged={vi.fn()}
            packages={[]}
            projects={[{ id: location.projectId, name: "One", available: true, harnesses: ["codex", "claude-code"] }]}
            sources={[{ id: source.sourceId, name: "Personal" }]}
          />
        </I18nProvider>,
      ),
    );
    await settle();
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((item) => item.textContent === "Review restore")
        ?.click(),
    );
    await settle();
    expect(container.querySelector(".propagation-restore")).not.toBeNull();
    expect(container.textContent).toContain("Personal");
    expect(container.textContent).toContain("One");
    expect(container.textContent).toContain("Recovery required");
    expect(container.textContent).toContain("SKILL.md");
    expect(container.textContent).toContain("image.png");
    expect(container.textContent).toContain("Binary file restored");
    expect([...container.querySelectorAll(".propagation-restore-file h4")].map((item) => item.textContent)).toEqual([
      "SKILL.md",
      "SKILL.md",
      "image.png",
    ]);
    expect(container.querySelector(".changes-diff-line")).not.toBeNull();
    expect([...container.querySelectorAll("details")].every((item) => !item.open)).toBe(true);
    expect(container.textContent).not.toContain("Claude Code · Previous revision");
  });
  it("loads the original propagation context when opening a restore route directly", async () => {
    api.readSkillOperationResult.mockResolvedValue({
      ...savedResult,
      source: { status: "unchanged", sourceId: source.sourceId },
      propagation: { ...savedResult.propagation, mode: "maintain-current" },
    });
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <OperationChangesWorkbench
            api={api as unknown as DesktopApi}
            artifacts={[]}
            initialJourney="draft"
            initialRestoreOperationId="operation-original"
            onClose={vi.fn()}
            onSourceChanged={vi.fn()}
            packages={[]}
            projects={[]}
            sources={[]}
          />
        </I18nProvider>,
      ),
    );
    await settle();
    expect(api.readSkillOperationResult).toHaveBeenCalledWith({ intentId: "operation-original" });
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "restore", operationId: "operation-original" },
    });
    expect(container.querySelector(".changes-workbench")?.classList.contains("propagation-workbench")).toBe(true);
    expect(container.querySelector(".propagation-source")?.textContent).toContain("Marketplace already current");
    expect(container.querySelector(".propagation-source")?.textContent).not.toContain(
      "previous version will be restored",
    );
  });
  it("records deselected safe copies as unselected after a source-only result", async () => {
    api.applySkillOperation.mockResolvedValue({
      ...savedResult,
      status: "applied",
      propagation: undefined,
      targets: [],
    });
    await renderPreview();
    act(() => container.querySelector<HTMLButtonElement>("#changes-tab-targets")?.click());
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    await settle();
    act(() => container.querySelector<HTMLButtonElement>(".changes-primary")?.click());
    await settle();
    expect(container.querySelector('[data-outcome="unselected"]')?.textContent).toContain("Not selected");
    expect(container.querySelector('[data-outcome="retained-local"]')?.textContent).toContain("Local changes kept");
  });
  it("uses source-only intent when the initial update has no eligible locations", async () => {
    await renderPreview({ ...intent, locations: [peer] });
    expect(api.previewSkillOperation).toHaveBeenLastCalledWith({ intent: { kind: "write", request } });
    expect(container.querySelector(".changes-primary")?.textContent).toBe("Update skill");
  });
  it("navigates Compare and Projects by keyboard and preserves disabled Result", async () => {
    await renderPreview();
    const compare = container.querySelector<HTMLButtonElement>("#changes-tab-diff")!;
    act(() => {
      compare.focus();
      compare.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement?.id).toBe("changes-tab-targets");
    expect(container.querySelector("#changes-tab-targets")?.getAttribute("aria-selected")).toBe("true");
    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement?.id).toBe("changes-tab-diff");
    expect(container.querySelector<HTMLButtonElement>("#changes-tab-result")?.disabled).toBe(true);
  });
});
