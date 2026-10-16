// @vitest-environment jsdom
//
// Renderer coverage for Brief 33c, D6 (worktree hygiene): the cleanup page's segmented control
// previews a write-harness-setting operation and applies it through the register-mcp page
// grammar, Codex's row stays informational, and the Review label reads "Claude Code worktree
// cleanup: {days} days" (or "off").
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HarnessSettingPage } from "../../src/renderer/operations/HarnessSettingPage";
import { CompletedOperations } from "../../src/renderer/review/CompletedOperations";
import { I18nProvider, useI18n } from "../../src/renderer/i18n";
import type { OperationReceipt, PreviewMarketplaceResponse } from "../../src/shared/operations-ipc";
import type { DesktopApi } from "../../src/shared/ipc";

function render(element: ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(<I18nProvider initialLanguage="en">{element}</I18nProvider>));
  return { container, root };
}

function segmentButton(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>(".ui-segmented-control__item")].find(
      (button) => button.textContent === label,
    ) ?? null
  );
}

describe("HarnessSettingPage", () => {
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

  it("shows the Codex row as informational only, with no control", async () => {
    const api = {
      previewOperation: vi.fn().mockResolvedValue({ status: "blocked", reason: "test", diagnostic: "unused" }),
    } as unknown as DesktopApi;
    rendered = render(
      <HarnessSettingPage api={api} onNavigateToRoute={() => undefined} returnTo={{ screen: "activity-worktrees" }} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Codex has no cleanup setting yet.");
    expect(rendered.container.querySelectorAll(".ui-segmented-control")).toHaveLength(1);
  });

  it("previews write-harness-setting for the selected days and applies it on confirm", async () => {
    const previewOperation = vi.fn(async (request: { kind: string }): Promise<PreviewMarketplaceResponse> => ({
      status: "ready",
      plan: {
        planId: "plan-cleanup-14",
        kind: "write-harness-setting",
        displayTarget: "~/.claude/settings.json",
        actions: [
          {
            kind: "write-file",
            relativePath: ".claude/settings.json",
            byteLength: 42,
            diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
        git: { mode: "not-a-repository", warnings: [] },
      },
    }));
    const applyOperation = vi.fn().mockResolvedValue({
      status: "applied",
      receipt: {
        operationId: "op-cleanup-14",
        kind: "write-harness-setting",
        status: "applied",
        appliedAt: "2026-09-14T12:00:00.000Z",
        displayTarget: "~/.claude/settings.json",
        actions: [],
        git: { mode: "not-a-repository" },
        registered: null,
        harnessSetting: { harness: "claude-code", key: "cleanupPeriodDays", value: 14, previousValue: null },
      },
    });
    const api = { previewOperation, applyOperation } as unknown as DesktopApi;
    rendered = render(
      <HarnessSettingPage api={api} onNavigateToRoute={() => undefined} returnTo={{ screen: "activity-worktrees" }} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => segmentButton(rendered!.container, "14 days")?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(previewOperation).toHaveBeenCalledWith({
      kind: "write-harness-setting",
      harness: "claude-code",
      key: "cleanupPeriodDays",
      value: 14,
    });
    expect(rendered.container.textContent).toContain("What will change");
    const applyButton = rendered.container.querySelector<HTMLButtonElement>("[data-testid='harness-setting-apply']");
    expect(applyButton?.disabled).toBe(false);
    act(() => applyButton?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(applyOperation).toHaveBeenCalledWith({ planId: "plan-cleanup-14" });
    expect(rendered.container.querySelector("[data-testid='harness-setting-result']")).not.toBeNull();
  });
});

function LabelProbe({ receipt }: Readonly<{ receipt: OperationReceipt }>) {
  const { language, t } = useI18n();
  return <CompletedOperations language={language} receipts={[receipt]} t={t} />;
}

describe("Review label for write-harness-setting", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
  });

  it("reads 'Claude Code worktree cleanup: 14 days' for a set value", () => {
    const receipt: OperationReceipt = {
      operationId: "op-1",
      kind: "write-harness-setting",
      status: "applied",
      appliedAt: "2026-09-14T12:00:00.000Z",
      displayTarget: "~/.claude/settings.json",
      actions: [],
      git: { mode: "not-a-repository" },
      registered: null,
      harnessSetting: { harness: "claude-code", key: "cleanupPeriodDays", value: 14, previousValue: null },
    };
    rendered = render(<LabelProbe receipt={receipt} />);
    expect(rendered.container.textContent).toContain("Claude Code worktree cleanup: 14 days");
  });

  it("reads 'Claude Code worktree cleanup: off' when the value was cleared", () => {
    const receipt: OperationReceipt = {
      operationId: "op-2",
      kind: "write-harness-setting",
      status: "applied",
      appliedAt: "2026-09-14T12:00:00.000Z",
      displayTarget: "~/.claude/settings.json",
      actions: [],
      git: { mode: "not-a-repository" },
      registered: null,
      harnessSetting: { harness: "claude-code", key: "cleanupPeriodDays", value: null, previousValue: 14 },
    };
    rendered = render(<LabelProbe receipt={receipt} />);
    expect(rendered.container.textContent).toContain("Claude Code worktree cleanup: off");
  });

  it("reads 'Paused agent x' / 'Killed agent x' / 'Reniced agent x' for the new process action kinds", () => {
    const paused: OperationReceipt = {
      operationId: "op-3",
      kind: "signal-process",
      status: "applied",
      appliedAt: "2026-09-14T12:00:00.000Z",
      displayTarget: "codex exec --brief",
      actions: [],
      git: { mode: "unavailable" },
      registered: null,
      signalAction: "pause",
    };
    rendered = render(<LabelProbe receipt={paused} />);
    expect(rendered.container.textContent).toContain("Paused agent codex exec --brief");
    act(() => rendered?.root.unmount());
    rendered?.container.remove();

    const reniced: OperationReceipt = {
      operationId: "op-4",
      kind: "renice-process",
      status: "applied",
      appliedAt: "2026-09-14T12:00:00.000Z",
      displayTarget: "codex exec --brief",
      actions: [],
      git: { mode: "unavailable" },
      registered: null,
      nice: 10,
    };
    rendered = render(<LabelProbe receipt={reniced} />);
    expect(rendered.container.textContent).toContain("Reniced agent codex exec --brief");
  });
});
