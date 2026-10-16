// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../src/renderer/i18n";
import { ReceiptWorkbench } from "../../src/renderer/canvas/changes/ReceiptWorkbench";
import { isReceiptRestorable } from "../../src/renderer/review/CompletedOperations";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationReceipt } from "../../src/shared/operations-ipc";

const baseReceipt: OperationReceipt = {
  operationId: "operation-one",
  kind: "import-artifact",
  status: "applied",
  // "Applied today at …" is asserted below: the fixture is stamped at test time, not on a date
  // that stops being "today" at midnight.
  appliedAt: new Date().toISOString(),
  displayTarget: "packages/demo",
  actions: [
    {
      kind: "write-file",
      relativePath: "packages/demo/SKILL.md",
      status: "applied",
      beforeHash: "a".repeat(64),
      byteLength: 12,
    },
    { kind: "write-file", relativePath: "packages/demo/NEW.md", status: "applied", byteLength: 5 },
  ],
  git: { mode: "commit", commit: "d1aeb9c" },
  registered: { sourceId: "personal" },
  files: [
    { relativePath: "packages/demo/SKILL.md", contentHash: "b".repeat(64) },
    { relativePath: "packages/demo/NEW.md", contentHash: "c".repeat(64) },
  ],
  manifests: [
    { relativePath: "packages/demo/omni.plugin.json", beforeHash: "e".repeat(64), afterHash: "f".repeat(64) },
  ],
  provenance: {
    agent: { harness: "claude-code", sessionName: "session-x", requestedAt: "2026-09-14T09:40:00.000Z" },
    approval: "conversation",
    reason: "Keep the project current",
  },
};

function render(
  api: DesktopApi,
  receipt = baseReceipt,
): { container: HTMLDivElement; root: Root; navigate: ReturnType<typeof vi.fn> } {
  const container = document.createElement("div");
  const root = createRoot(container);
  const navigate = vi.fn();
  document.body.append(container);
  act(() =>
    root.render(
      <I18nProvider>
        <ReceiptWorkbench
          api={api}
          operationId={receipt.operationId}
          onNavigateToRoute={navigate}
          returnTo={{ screen: "review" }}
        />
      </I18nProvider>,
    ),
  );
  return { container, root, navigate };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("receipt page", () => {
  it("keeps a failed composite unavailable while its successful import child remains restorable", () => {
    const failedComposite: OperationReceipt = {
      ...baseReceipt,
      operationId: "composite",
      kind: "add-to-project",
      status: "failed",
      failedStep: "assign",
      children: ["import-child", "assign-child"],
    };
    const importChild = { ...baseReceipt, operationId: "import-child" };
    const assignChild = { ...baseReceipt, operationId: "assign-child", kind: "apply-plan" as const };
    expect(isReceiptRestorable(failedComposite, [failedComposite, importChild, assignChild])).toBe(false);
    expect(isReceiptRestorable(importChild, [failedComposite, importChild, assignChild])).toBe(true);
  });

  it("labels receipt children with their operation and time and marks missing children", async () => {
    const parent: OperationReceipt = {
      ...baseReceipt,
      operationId: "composite",
      kind: "add-to-project",
      displayTarget: "quality → ui → Demo",
      children: ["import-child", "missing-child"],
    };
    const child: OperationReceipt = {
      ...baseReceipt,
      operationId: "import-child",
      appliedAt: "2026-09-14T08:15:00.000Z",
    };
    const rendered = render(
      {
        listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [parent, child] }),
      } as unknown as DesktopApi,
      parent,
    );
    await settle();
    expect(rendered.container.textContent).toContain("Import");
    expect(rendered.container.textContent).toMatch(/\d{2}:15/);
    expect(rendered.container.textContent).toContain("Receipt not found");
    const missing = [...rendered.container.querySelectorAll(".ui-item")].find((item) =>
      item.textContent?.includes("Receipt not found"),
    );
    expect(missing?.className).not.toContain("clickable");
    rendered.root.unmount();
  });

  it("shows applied files, manifests, Git, origin, and loads a diff on demand", async () => {
    const getReceiptDiff = vi.fn().mockResolvedValue({
      status: "ready",
      diff: { kind: "unified", text: "-before\n+after\n", truncated: false },
      before: { byteLength: 7 },
      after: { byteLength: 6, changedSince: false },
    });
    const rendered = render({
      listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [baseReceipt] }),
      getReceiptDiff,
    } as unknown as DesktopApi);
    await settle();
    expect(rendered.container.textContent).toMatch(/Applied today at \d{2}:\d{2} · commit d1aeb9c/);
    expect(rendered.container.textContent).toContain("packages/demo/SKILL.md");
    expect(rendered.container.textContent).toContain("added");
    expect(rendered.container.textContent).toContain("eeeeeee → fffffff");
    expect(rendered.container.textContent).toContain(
      "Requested by Claude Code · session session-x · reason: Keep the project current",
    );
    expect(rendered.container.textContent).toContain("Consented in the conversation");
    const toggle = rendered.container.querySelector<HTMLButtonElement>(
      "[data-testid='receipt-diff-toggle-packages-demo-SKILL.md']",
    );
    expect(toggle).not.toBeNull();
    act(() => toggle?.click());
    await settle();
    expect(getReceiptDiff).toHaveBeenCalledWith({
      operationId: "operation-one",
      relativePath: "packages/demo/SKILL.md",
    });
    expect(rendered.container.textContent).toContain("-before");
    rendered.root.unmount();
  });

  it("shows failed diagnostics and restored or unavailable footer states", async () => {
    const failed = { ...baseReceipt, status: "failed" as const, diagnostic: "The write failed." };
    const rendered = render(
      { listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [failed] }) } as unknown as DesktopApi,
      failed,
    );
    await settle();
    expect(rendered.container.textContent).toContain("The write failed.");
    expect(rendered.container.textContent).toMatch(/Failed today at \d{2}:\d{2}/);
    expect(rendered.container.querySelector("[data-testid='receipt-restore']")).toBeNull();
    rendered.root.unmount();

    const restored = { ...baseReceipt, restored: true };
    const restoredView = render(
      { listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [restored] }) } as unknown as DesktopApi,
      restored,
    );
    await settle();
    expect(restoredView.container.textContent).toContain("Restored on");
    restoredView.root.unmount();

    const unavailable = render({
      listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [] }),
    } as unknown as DesktopApi);
    await settle();
    expect(unavailable.container.textContent).toContain("Receipt unavailable");
    unavailable.root.unmount();
  });

  it("opens a managed removal restore in the project canvas Changes workbench", async () => {
    const removal: OperationReceipt = {
      ...baseReceipt,
      operationId: "remove-receipt",
      kind: "remove-binding",
      displayTarget: "Project One",
      project: { id: "project-one" },
      registered: null,
      bindings: [
        {
          bindingId: "binding-one",
          before: {
            bindingId: "binding-one",
            sourceId: "personal",
            packageId: "plugins/demo",
            artifactPath: "skills/demo",
            kind: "skill",
            projectId: "project-one",
            harnessId: "claude-code",
            boundHash: "a".repeat(64),
            createdAt: new Date().toISOString(),
          },
        },
      ],
      files: [{ relativePath: ".claude/skills/demo/SKILL.md", contentHash: "b".repeat(64) }],
    };
    const rendered = render(
      {
        listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [removal] }),
      } as unknown as DesktopApi,
      removal,
    );
    await settle();
    act(() => rendered.container.querySelector<HTMLButtonElement>("[data-testid='receipt-restore']")?.click());

    expect(rendered.navigate).toHaveBeenCalledWith({
      screen: "resource-canvas",
      context: { kind: "entry", entry: { kind: "project", id: "project-one" } },
      initialSkillRestoreOperationId: "remove-receipt",
    });
    rendered.root.unmount();
  });

  it("opens a propagation restore in its source canvas context", async () => {
    const child: OperationReceipt = { ...baseReceipt, operationId: "copy-operation", kind: "propagate-skill" };
    const propagation: OperationReceipt = {
      ...baseReceipt,
      operationId: "propagation-operation",
      kind: "skill-management",
      displayTarget: "Restore linked copies · demo",
      children: [child.operationId],
      skillManagement: {
        intentId: "propagation-operation",
        operationId: "propagation-operation",
        status: "applied",
        source: { status: "updated", sourceId: "personal" },
        targets: [],
        receiptIds: [child.operationId],
        issues: [],
        recoveryAvailable: false,
        propagation: {
          mode: "maintain-current",
          source: { sourceId: "personal", packageId: "packages/tools", artifactPath: "skills/demo" },
          targets: [],
        },
      },
    };
    const rendered = render(
      {
        listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [propagation, child] }),
      } as unknown as DesktopApi,
      propagation,
    );
    await settle();
    act(() => rendered.container.querySelector<HTMLButtonElement>("[data-testid='receipt-restore']")?.click());
    expect(rendered.navigate).toHaveBeenCalledWith({
      screen: "resource-canvas",
      context: { kind: "entry", entry: { kind: "source", id: "personal" } },
      initialSkillRestoreOperationId: "propagation-operation",
    });
    rendered.root.unmount();
  });

  it("keeps generic skill-management restores in the workspace context", async () => {
    const child: OperationReceipt = { ...baseReceipt, operationId: "write-operation", kind: "write-skill" };
    const receipt: OperationReceipt = {
      ...baseReceipt,
      kind: "skill-management",
      children: [child.operationId],
      skillManagement: {
        intentId: baseReceipt.operationId,
        operationId: baseReceipt.operationId,
        status: "applied",
        source: { status: "updated", sourceId: "personal" },
        targets: [],
        receiptIds: [child.operationId],
        issues: [],
        recoveryAvailable: false,
      },
    };
    const rendered = render(
      {
        listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [receipt, child] }),
      } as unknown as DesktopApi,
      receipt,
    );
    await settle();
    act(() => rendered.container.querySelector<HTMLButtonElement>("[data-testid='receipt-restore']")?.click());
    expect(rendered.navigate).toHaveBeenCalledWith({
      screen: "resource-canvas",
      context: { kind: "workspace" },
      initialSkillRestoreOperationId: receipt.operationId,
    });
    rendered.root.unmount();
  });
});
