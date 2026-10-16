// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AgentRequest } from "../../src/shared/agents-ipc";
import type { DesktopApi } from "../../src/shared/ipc";
import { I18nProvider } from "../../src/renderer/i18n";
import { agentRequestRoute } from "../../src/renderer/review/agent-requests";
import { isReceiptRestorable } from "../../src/renderer/review/CompletedOperations";
import { RegisterProjectWorkbench } from "../../src/renderer/canvas/changes/RegisterProjectWorkbench";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const request: AgentRequest = {
  requestId: "register-request",
  createdAt: "2026-10-14T00:00:00.000Z",
  expiresAt: "2026-10-14T00:00:00.000Z",
  approval: "omni",
  status: "pending",
  harness: "codex",
  request: { kind: "register-project", cwd: "/project", path: "/project" },
  plan: {
    kind: "register-project",
    planId: "register-plan",
    displayTarget: "project",
    actions: [],
    git: { mode: "disabled", warnings: [] },
    projectRegistration: {
      cwd: "/project",
      path: "/project",
      gitRoot: true,
      device: "1",
      inode: "2",
      revision: 1,
      action: "register",
    },
  },
};
it("routes registration approval to the existing canvas operation sheet", () => {
  expect(agentRequestRoute(request)).toMatchObject({
    screen: "resource-canvas",
    initialOperation: { screen: "operation-register-project", requestId: request.requestId },
  });
});
it("lets Desktop approve registration and offers Undo from the receipt", async () => {
  const receipt = {
    operationId: "register-op",
    kind: "register-project" as const,
    status: "applied" as const,
    appliedAt: "2026-10-14T00:00:01.000Z",
    displayTarget: "project",
    actions: [],
    git: { mode: "disabled" as const },
    registered: null,
    project: { id: "new-project" },
  };
  expect(isReceiptRestorable(receipt, [receipt])).toBe(true);
  const applyOperation = vi.fn(async () => ({ status: "applied", receipt }));
  const resolveAgentRequest = vi.fn();
  const api = {
    listAgentRequests: async () => ({ status: "ready", requests: [request] }),
    refreshAgentRequest: async () => request,
    beginAgentApply: async () => ({ leaseId: "lease", approvedAt: receipt.appliedAt }),
    endAgentApply: vi.fn(),
    resolveAgentRequest,
    applyOperation,
    listOperations: async () => ({ status: "ready", receipts: [receipt] }),
  } as unknown as DesktopApi;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <RegisterProjectWorkbench
            api={api}
            requestId={request.requestId}
            onClose={() => undefined}
            onNavigate={() => undefined}
          />
        </I18nProvider>,
      ),
    );
    expect(container.textContent).toContain("Nothing is written in the project folder");
    await act(async () =>
      (container.querySelector('[data-testid="register-project-approve"]') as HTMLButtonElement).click(),
    );
    expect(applyOperation).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "register-plan", provenance: expect.objectContaining({ approval: "omni" }) }),
    );
    expect(resolveAgentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: request.requestId, operationIds: [receipt.operationId], leaseId: "lease" }),
    );
    expect(container.querySelector('[data-testid="workbench-restore"]')?.textContent).toBe("Undo");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
