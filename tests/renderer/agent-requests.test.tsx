// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../src/renderer/i18n";
import { AgentRequests, agentRequestRoute } from "../../src/renderer/review/agent-requests";
import { AgentRequestBanner } from "../../src/renderer/operations/AgentRequestBanner";
import type { DesktopApi } from "../../src/shared/ipc";
import type { AgentRequest } from "../../src/shared/agents-ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const request: AgentRequest = {
  requestId: "request-one",
  createdAt: "2026-09-14T00:00:00.000Z",
  expiresAt: "2026-09-14T00:10:00.000Z",
  harness: "claude-code",
  sessionName: "iterative-sprouting-lamport",
  request: { kind: "make-compatible", sourceId: "personal", harness: "codex", packageId: "claude-plugins" },
  plan: {
    planId: "plan-one",
    kind: "make-compatible",
    displayTarget: "claude-plugins",
    actions: [],
    git: { mode: "commit", warnings: [] },
  },
  approval: "omni",
  status: "pending",
  approvalReason: { code: "deletes-files", count: 2 },
};
const managedRequest: AgentRequest = {
  ...request,
  request: { kind: "remove-skill", bindingIds: ["binding-one"] },
  intentId: "managed-intent-one",
  skillIntent: { kind: "remove", bindingIds: ["binding-one"] },
};

function render(element: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<I18nProvider initialLanguage="en">{element}</I18nProvider>));
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("agent request renderer surfaces", () => {
  it.each([
    ["en", 1, "Deletes 1 file"],
    ["en", 2, "Deletes 2 files"],
    ["fr", 1, "Supprime 1 fichier"],
    ["fr", 2, "Supprime 2 fichiers"],
  ] as const)("renders the deletion reason in %s for %i files", async (language, count, expected) => {
    const localized = { ...request, approvalReason: { code: "deletes-files" as const, count } };
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.append(container);
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage={language}>
          <AgentRequests
            api={
              { listAgentRequests: async () => ({ status: "ready", requests: [localized] }) } as unknown as DesktopApi
            }
          />
        </I18nProvider>,
      ),
    );
    expect(container.querySelector(".ui-item__sub")?.textContent).toContain(expected);
    act(() => root.unmount());
  });

  it("keeps old records readable when they have no approval reason", async () => {
    const legacy = { ...request, approvalReason: undefined };
    const rendered = render(
      <AgentRequests
        api={{ listAgentRequests: async () => ({ status: "ready", requests: [legacy] }) } as unknown as DesktopApi}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("iterative-sprouting-lamport");
    expect(rendered.container.textContent).not.toContain("undefined");
    act(() => rendered.root.unmount());
  });

  it("keeps decline disabled while an assignment is applying", async () => {
    const decline = vi.fn();
    const api = {
      listAgentRequests: vi.fn().mockResolvedValue({ status: "ready", requests: [request] }),
      declineAgentRequest: decline,
    } as unknown as DesktopApi;
    const rendered = render(<AgentRequestBanner api={api} applying requestId={request.requestId} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const button = rendered.container.querySelector<HTMLButtonElement>("[data-testid='agent-request-decline']");
    expect(button?.disabled).toBe(true);
    act(() => button?.click());
    expect(decline).not.toHaveBeenCalled();
    act(() => rendered.root.unmount());
  });

  it("lists a pending request in Review and opens its preview route", async () => {
    const api = {
      listAgentRequests: vi.fn().mockResolvedValue({ status: "ready", requests: [request] }),
    } as unknown as DesktopApi;
    const navigate = vi.fn();
    const rendered = render(<AgentRequests api={api} onNavigate={navigate} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='review-agent-requests']")?.textContent).toContain(
      "iterative-sprouting-lamport",
    );
    expect(rendered.container.textContent).toContain("Deletes 2 files");
    act(() =>
      rendered.container.querySelector<HTMLButtonElement>("[data-testid='agent-request-request-one']")?.click(),
    );
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-one",
        screen: "resource-canvas",
        initialOperation: expect.objectContaining({ screen: "operation-compatible", requestId: "request-one" }),
      }),
    );
    act(() => rendered.root.unmount());
  });

  it("opens a linked managed request in Changes with the saved intent", async () => {
    const api = {
      listAgentRequests: vi.fn().mockResolvedValue({ status: "ready", requests: [managedRequest] }),
    } as unknown as DesktopApi;
    const navigate = vi.fn();
    const rendered = render(<AgentRequests api={api} onNavigate={navigate} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() =>
      rendered.container.querySelector<HTMLButtonElement>("[data-testid='agent-request-request-one']")?.click(),
    );

    expect(navigate).toHaveBeenCalledWith({
      screen: "resource-canvas",
      context: { kind: "workspace" },
      initialSkillIntent: { kind: "remove", bindingIds: ["binding-one"] },
      initialSkillIntentId: "managed-intent-one",
      requestId: "request-one",
    });
    act(() => rendered.root.unmount());
  });

  it("refreshes pending request visibility on persisted review events without reload", async () => {
    let notify: (() => void) | undefined;
    const listAgentRequests = vi
      .fn()
      .mockResolvedValueOnce({ status: "ready", requests: [] })
      .mockResolvedValueOnce({ status: "ready", requests: [managedRequest] });
    const api = {
      listAgentRequests,
      onReviewChanged: (listener: () => void) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    } as unknown as DesktopApi;
    const rendered = render(<AgentRequests api={api} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='review-agent-requests']")).toBeNull();

    await act(async () => {
      notify?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='agent-request-request-one']")?.textContent).toContain(
      "Review removal",
    );
    expect(listAgentRequests).toHaveBeenCalledTimes(2);
    act(() => rendered.root.unmount());
  });

  it("updates the banner reason when recomputation changes the stored request", async () => {
    let notify: (() => void) | undefined;
    const api = {
      listAgentRequests: vi
        .fn()
        .mockResolvedValueOnce({ status: "ready", requests: [request] })
        .mockResolvedValue({
          status: "ready",
          requests: [{ ...request, approvalReason: { code: "deletes-files", count: 1 } }],
        }),
      onReviewChanged: (listener: () => void) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    } as unknown as DesktopApi;
    const rendered = render(<AgentRequestBanner api={api} requestId={request.requestId} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Deletes 2 files");
    await act(async () => {
      notify?.();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Deletes 1 file");
    expect(rendered.container.textContent).not.toContain("Deletes 2 files");
    act(() => rendered.root.unmount());
  });

  it("shows a banner and declines the request", async () => {
    const decline = vi.fn().mockResolvedValue(request);
    const api = {
      listAgentRequests: vi.fn().mockResolvedValue({ status: "ready", requests: [request] }),
      declineAgentRequest: decline,
    } as unknown as DesktopApi;
    const rendered = render(<AgentRequestBanner api={api} requestId={request.requestId} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='agent-request-banner']")?.textContent).toContain(
      "Requested by",
    );
    expect(rendered.container.textContent).toContain("Deletes 2 files");
    act(() => rendered.container.querySelector<HTMLButtonElement>("[data-testid='agent-request-decline']")?.click());
    expect(decline).toHaveBeenCalledWith({ requestId: request.requestId });
    act(() => rendered.root.unmount());
  });
});

it("presents a localized publication reason and opens its canvas publication sheet", async () => {
  const publication: AgentRequest = {
    ...request,
    request: { kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" },
    plan: {
      kind: "publish-plugin",
      planId: "publication-plan",
      displayTarget: "plugins/demo",
      actions: [],
      git: { mode: "commit", warnings: [] },
    },
    approvalReason: { code: "public-publication" },
  };
  const rendered = render(
    <AgentRequests
      api={{ listAgentRequests: async () => ({ status: "ready", requests: [publication] }) } as unknown as DesktopApi}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(rendered.container.textContent).toContain("Publish on GitHub: visible to everyone");
  expect(rendered.container.textContent).not.toContain("Capture");
  expect(rendered.container.textContent).not.toContain("undefined");
  expect(agentRequestRoute(publication)).toEqual({
    screen: "resource-canvas",
    context: { kind: "workspace" },
    initialPublicationRequest: publication,
  });
  act(() => rendered.root.unmount());
});
