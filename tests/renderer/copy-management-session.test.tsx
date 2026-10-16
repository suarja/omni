// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { expect, test, vi } from "vitest";
import { CanvasSkillCopiesLayer } from "../../src/renderer/canvas/CanvasSkillCopiesLayer";
import { I18nProvider } from "../../src/renderer/i18n";
import { locationA, node, render, snapshot } from "./skill-copy-comparison-fixtures";

test("a reopened copy result survives transient observation loading", async () => {
  const onSavedRouteResolved = vi.fn();
  const props: ComponentProps<typeof CanvasSkillCopiesLayer> = {
    api: {
      readSkillOperationResult: vi.fn(async () => ({
        intentId: "intent-one",
        operationId: "operation-one",
        status: "restored",
        source: { status: "unchanged" },
        targets: [],
        receiptIds: [],
        issues: [],
        recoveryAvailable: false,
        detachment: {
          choice: "detach-managed",
          skillId: node.skillId,
          location: locationA,
          source: { sourceId: "source-one", packageId: "package-one", artifactPath: "skills/review" },
          bindingId: "binding-one",
          status: "restored",
        },
      })),
    } as ComponentProps<typeof CanvasSkillCopiesLayer>["api"],
    onClose: vi.fn(),
    onEnsureGrant: async () => "grant",
    onObserveAdoptionSource: undefined,
    onRefresh: vi.fn(),
    onApplyingChange: vi.fn(),
    onOpenChange: vi.fn(),
    reader: null,
    snapshot,
    managedUses: [],
    managedUsesStatus: "ready",
    rootKey: "root",
    visible: true,
    operationOpen: false,
    backRef: { current: vi.fn() },
    closeRef: { current: vi.fn() },
    copyNodes: [node],
    projectId: locationA.projectId,
    projectStatus: "ready",
    savedRouteId: "intent-one",
    initialRestoreReview: false,
    onSavedRouteResolved,
  };
  const rendered = render(<CanvasSkillCopiesLayer {...props} />);
  const update = async (status: typeof props.projectStatus): Promise<void> => {
    await act(async () =>
      rendered.root.render(
        <I18nProvider initialLanguage="en">
          <CanvasSkillCopiesLayer {...props} projectStatus={status} copyNodes={status === "ready" ? [node] : []} />
        </I18nProvider>,
      ),
    );
  };
  try {
    await act(async () => {
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    });
    expect(rendered.container.querySelector('[data-testid="copy-management-workbench"]')).not.toBeNull();
    await update("idle");
    await update("loading");
    expect(rendered.container.querySelector('[data-testid="copy-management-workbench"]')).not.toBeNull();
    expect(onSavedRouteResolved).not.toHaveBeenCalledWith("intent-one", false);
    await update("ready");
    expect(rendered.container.querySelector('[data-testid="copy-management-result"]')?.textContent).toContain(
      "Restored",
    );
    await act(async () =>
      rendered.root.render(
        <I18nProvider initialLanguage="en">
          <CanvasSkillCopiesLayer {...props} savedRouteId={undefined} />
        </I18nProvider>,
      ),
    );
    expect(rendered.container.querySelector('[data-testid="copy-management-workbench"]')).toBeNull();
  } finally {
    act(() => rendered.root.unmount());
  }
});
