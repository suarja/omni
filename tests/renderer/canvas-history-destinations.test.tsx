// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it } from "vitest";
import { renderExternal, click } from "./external-library-fixture";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => act(() => root.unmount()));

it.each([
  ["mattpocock/skills", "result"],
  ["mattpocock/skills", "undo"],
  ["missing/source", "result"],
  ["missing/source", "undo"],
])("opens the saved %s %s over its source page or the truthful workspace fallback", async (sourceId, action) => {
  const { api } = await renderExternal(root, { allFailed: true });
  const history = await api.listOperations();
  const result = {
    intentId: "saved-intent",
    operationId: "saved-operation",
    status: "applied" as const,
    source: { status: "unchanged" as const, sourceId },
    targets: [],
    receiptIds: [],
    issues: [],
    recoveryAvailable: false,
  };
  api.listOperations.mockResolvedValue({
    ...history,
    receipts: [
      {
        ...history.receipts[0]!,
        operationId: "saved-operation",
        status: "applied",
        skillManagement: result,
        children: ["saved-child"],
      },
      { ...history.receipts[0]!, operationId: "saved-child", kind: "apply-plan", status: "applied" },
    ],
  });
  api.readSkillOperationResult.mockResolvedValue({ ...result, receipts: [] });
  await click(container, "Historique");
  const receipt = container.querySelector('[data-operation-id="saved-operation"]')!;
  if (action === "undo") await click(receipt, "Annuler");
  else await act(async () => receipt.querySelector<HTMLButtonElement>(".rail-history-entry")!.click());
  expect(container.querySelector('[data-testid="changes-workbench"]')).not.toBeNull();
  if (sourceId === "mattpocock/skills")
    expect(container.querySelector('[data-testid="external-source-page"]')).not.toBeNull();
  else {
    expect(container.querySelector('[data-testid="external-source-page"]')).toBeNull();
    expect(container.querySelector('[data-testid="marketplace-page"]')).toBeNull();
    expect(container.querySelector(".canvas-breadcrumbs")?.textContent).toBe("Espace de travail");
  }
  if (action === "undo")
    expect(api.previewSkillOperation).toHaveBeenCalledWith({
      intent: { kind: "restore", operationId: "saved-operation" },
    });
});
