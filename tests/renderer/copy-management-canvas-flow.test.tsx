// @vitest-environment jsdom
import { act } from "react";
import { expect, test, vi } from "vitest";

import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import type { DesktopApi } from "../../src/shared/ipc";
import {
  canvasCopySnapshot,
  locationA,
  observedCopies,
  readyForRequest,
  ref,
  render,
} from "./skill-copy-comparison-fixtures";

test.each(["button", "Escape"])("opens a saved result on its exact copy and closes with %s", async (method) => {
  let observedSkillId: string | undefined;
  let markObserved!: () => void;
  const observed = new Promise<void>((resolve) => {
    markObserved = resolve;
  });
  const api = {
    observeSkillCopies: vi.fn(async (request) => {
      const result = observedCopies(request);
      observedSkillId = result.groups[0]?.correlation.groups[0]?.skillId;
      markObserved();
      return result;
    }),
    compareSkillCopies: vi.fn(async (request) => readyForRequest(request, "copy comparison")),
    readSkillOperationResult: vi.fn(async ({ intentId }) => {
      await observed;
      return {
        intentId,
        operationId: "operation-one",
        status: "applied" as const,
        source: { status: "unchanged" as const },
        targets: [],
        receiptIds: [],
        issues: [],
        recoveryAvailable: false,
        detachment: {
          choice: "detach-managed" as const,
          skillId: observedSkillId ?? "",
          location: locationA,
          source: { sourceId: "source-one", packageId: "package-one", artifactPath: "skills/review" },
          bindingId: "binding-one",
          status: "detached" as const,
        },
      };
    }),
  } as unknown as DesktopApi;
  const rendered = render(
    <ResourceCanvas
      api={api}
      context={{ kind: "entry", entry: ref.entry }}
      initialSkillResultId="intent-one"
      onEnsureGrant={async () => "project-grant"}
      onNavigate={vi.fn()}
      onNavigateDestination={vi.fn()}
      onRefresh={vi.fn()}
      snapshot={canvasCopySnapshot()}
    />,
  );
  try {
    await act(async () => {
      for (let turn = 0; turn < 32; turn += 1) await Promise.resolve();
    });

    expect(api.readSkillOperationResult).toHaveBeenCalledWith({ intentId: "intent-one" });
    expect(observedSkillId).toBeTruthy();
    expect(rendered.container.querySelector('[data-testid="copy-management-workbench"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-testid="changes-result"]')).not.toBeNull();
    expect(rendered.container.textContent).toContain("Management stopped");
    expect(rendered.container.textContent).toContain(locationA.folderPath);

    await act(async () => {
      if (method === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      else rendered.container.querySelector<HTMLButtonElement>('button[aria-label="Close copy management"]')?.click();
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
    expect(rendered.container.querySelector('[data-testid="copy-management-workbench"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="changes-workbench"]')).toBeNull();
  } finally {
    act(() => rendered.root.unmount());
  }
});
