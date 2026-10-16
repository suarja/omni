// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/renderer/i18n";
import { WorkflowWorkbench } from "../../src/renderer/canvas/changes/WorkflowWorkbench";
import type { OperationReceipt } from "../../src/shared/operations-ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps preview, effects, result, and guarded close in one sheet and returns focus on close", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const close = vi.fn();
  const render = async (busy = false, result = false): Promise<void> => {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="fr">
          <WorkflowWorkbench
            title="Review files"
            busy={busy}
            hasResult={result}
            onClose={close}
            targets={<p data-testid="effects">.agents/skills/review/SKILL.md</p>}
          >
            <label>
              Destination
              <input data-testid="destination" />
            </label>
          </WorkflowWorkbench>
        </I18nProvider>,
      ),
    );
  };
  try {
    await render();
    expect(container.querySelector('[data-testid="changes-workbench"]')).not.toBeNull();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Aperçu");
    await act(async () => container.querySelector<HTMLButtonElement>("#changes-tab-targets")?.click());
    expect(container.querySelector('[data-testid="effects"]')?.closest("[hidden]")).toBeNull();
    await render(true);
    expect(container.querySelector<HTMLInputElement>('[data-testid="destination"]')?.matches(":disabled")).toBe(true);
    act(() =>
      container
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(close).not.toHaveBeenCalled();
    await render(false, true);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Résultat");
    act(() =>
      container
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it("offers restore only for the current receipt after checking the saved history", async () => {
  const old: OperationReceipt = {
    operationId: "old",
    kind: "import-artifact",
    status: "applied",
    appliedAt: "2026-10-11T10:00:00Z",
    displayTarget: "review",
    actions: [],
    git: { mode: "unavailable" },
    registered: { sourceId: "source" },
  };
  const newer = { ...old, operationId: "newer", appliedAt: "2026-10-11T11:00:00Z" };
  const api = { listOperations: vi.fn(async () => ({ status: "ready" as const, receipts: [old, newer] })) };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const navigate = vi.fn();
  const render = async (receipt: OperationReceipt): Promise<void> => {
    await act(async () =>
      root.render(
        <I18nProvider>
          <WorkflowWorkbench
            title="Review"
            api={api}
            busy={false}
            hasResult
            receipt={receipt}
            onNavigate={navigate}
            onClose={vi.fn()}
          >
            <p>Result</p>
          </WorkflowWorkbench>
        </I18nProvider>,
      ),
    );
  };
  try {
    await render(old);
    expect(container.querySelector('[data-testid="workbench-restore"]')).toBeNull();
    await render(newer);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="workbench-restore"]')?.click());
    expect(navigate).toHaveBeenCalledWith({ screen: "operation-restore", operationId: "newer" });
    await render({ ...newer, status: "failed" });
    expect(container.querySelector('[data-testid="workbench-restore"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
