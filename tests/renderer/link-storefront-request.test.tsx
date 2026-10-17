// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AgentRequest } from "../../src/shared/agents-ipc";
import type { DesktopApi } from "../../src/shared/ipc";
import { I18nProvider } from "../../src/renderer/i18n";
import { agentRequestRoute } from "../../src/renderer/review/agent-requests";
import { isReceiptRestorable } from "../../src/renderer/review/CompletedOperations";
import { LinkStorefrontWorkbench } from "../../src/renderer/canvas/changes/LinkStorefrontWorkbench";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const request: AgentRequest = {
  requestId: "link-request",
  createdAt: "2026-10-17T00:00:00.000Z",
  expiresAt: "2026-10-17T00:00:00.000Z",
  approval: "omni",
  approvalReason: { code: "marketplace-setting" },
  status: "pending",
  harness: "codex",
  request: { kind: "link-storefront", path: "/storefront" },
  plan: {
    kind: "link-storefront",
    planId: "link-plan",
    displayTarget: "Storefront",
    actions: [],
    git: { mode: "disabled", warnings: [] },
    notes: ["Nothing is written in the storefront folder. Undo archives the link."],
    storefrontLink: {
      path: "/storefront",
      action: "link",
      revision: 1,
      fingerprint: "a".repeat(64),
      inspection: {
        status: "ready",
        displayName: "Storefront",
        isGitRepository: true,
        githubRepository: "fixture/storefront",
        plugins: [],
      },
      unlinkedPlugins: [{ pluginId: "foreign", reason: "ORIGIN.md is missing." }],
    },
  },
};
it("routes storefront approval to the existing workflow sheet and applies with agent consent", async () => {
  expect(agentRequestRoute(request)).toMatchObject({
    initialOperation: { screen: "operation-link-storefront", requestId: request.requestId },
  });
  const receipt = {
    operationId: "link-op",
    kind: "link-storefront" as const,
    status: "applied" as const,
    appliedAt: request.createdAt,
    displayTarget: "Storefront",
    actions: [],
    git: { mode: "disabled" as const },
    registered: { sourceId: "storefront" },
  };
  expect(isReceiptRestorable(receipt, [receipt])).toBe(true);
  expect(isReceiptRestorable({ ...receipt, kind: "archive-storefront" }, [receipt])).toBe(false);
  const applyOperation = vi.fn(async () => ({ status: "applied", receipt }));
  const endAgentApply = vi.fn();
  const api = {
    listAgentRequests: async () => ({ status: "ready", requests: [request] }),
    refreshAgentRequest: async () => request,
    beginAgentApply: async () => ({ leaseId: "lease", approvedAt: receipt.appliedAt }),
    endAgentApply,
    resolveAgentRequest: vi.fn(),
    applyOperation,
    listOperations: async () => ({ status: "ready", receipts: [receipt] }),
  } as unknown as DesktopApi;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const changed = vi.fn();
  try {
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <LinkStorefrontWorkbench
            api={api}
            requestId={request.requestId}
            onClose={() => undefined}
            onNavigate={() => undefined}
            onMarketplaceChanged={changed}
          />
        </I18nProvider>,
      ),
    );
    expect(container.textContent).toContain("Nothing is written in the storefront folder");
    expect(container.textContent).toContain("fixture/storefront");
    expect(container.textContent).toContain("ORIGIN.md is missing");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="link-storefront-approve"]')!.click(),
    );
    expect(applyOperation).toHaveBeenCalledWith({
      planId: "link-plan",
      provenance: { approval: "omni", agent: { harness: "codex", requestedAt: request.createdAt } },
    });
    expect(endAgentApply).toHaveBeenCalled();
    expect(changed).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="workbench-restore"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
