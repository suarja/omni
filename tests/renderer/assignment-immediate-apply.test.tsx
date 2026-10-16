// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Binding } from "../../src/domain/assignment-plan";
import type { DesktopApi } from "../../src/shared/ipc";
import { AssignmentWorkbench } from "../../src/renderer/canvas/changes/AssignmentWorkbench";
import { buildBindingsToSave } from "../../src/renderer/operations/assignment-page-helpers";
import { I18nProvider } from "../../src/renderer/i18n";
import { rootDestination } from "../../src/renderer/navigation";
import type { CatalogueUnit } from "../../src/renderer/catalogue/catalogue";

const source = {
  ref: { kind: "source" as const, id: "personal" },
  displayName: "My marketplace",
  displayRoot: "marketplace",
  availability: "available" as const,
  ownership: "personal" as const,
  capabilities: { observe: true as const, write: false as const },
};
const project = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Acme Web",
  displayRoot: "acme-web",
  availability: "available" as const,
};
const secondProject = {
  ref: { kind: "project" as const, id: "project-two" },
  displayName: "Notes App",
  displayRoot: "notes-app",
  availability: "available" as const,
};
const unit: CatalogueUnit = {
  unitId: "skill:architect",
  name: "architect",
  kind: "skill",
  unit: "skill-folder",
  occurrences: [
    {
      root: source.ref,
      relativePath: "skills/architect",
      contentHash: "a".repeat(64),
      packageId: "tools",
      physicalIdentity: "skills/architect",
    },
  ],
  inPersonalSource: true,
  personalHash: "a".repeat(64),
};
const baseline: Binding = {
  bindingId: "binding-one",
  sourceId: "personal",
  packageId: "tools",
  artifactPath: "skills/architect",
  kind: "skill",
  projectId: "project-one",
  harnessId: "codex",
  boundHash: "a".repeat(64),
  createdAt: "2026-09-13T10:00:00.000Z",
};
const initialPlan = {
  projectId: "project-one",
  planId: "plan-one",
  status: "ready" as const,
  actions: [
    {
      bindingId: "binding-one",
      harnessId: "codex" as const,
      kind: "skill" as const,
      relativePath: ".agents/skills/architect",
      state: "add" as const,
    },
  ],
};
const units = [
  { kind: "skill" as const, id: "architect", artifactPath: "skills/architect", contentHash: "a".repeat(64) },
];

function createApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    previewBindings: vi.fn().mockResolvedValue({ status: "ready", units, plans: [initialPlan] }),
    saveBindings: vi.fn().mockResolvedValue({ status: "ready", bindings: [] }),
    previewApply: vi.fn().mockResolvedValue({
      status: "ready",
      planId: "apply-one",
      actions: [],
      git: { mode: "disabled" },
      project: { displayName: "Acme Web" },
    }),
    runApply: vi.fn().mockResolvedValue({
      status: "applied",
      receipt: {
        operationId: "receipt-one",
        kind: "apply-plan",
        status: "applied",
        appliedAt: "2026-09-26T10:00:00.000Z",
        displayTarget: "Acme Web",
        actions: [],
        git: { mode: "disabled" },
        registered: null,
      },
    }),
    resolveAgentRequest: vi.fn().mockResolvedValue({}),
    beginAgentApply: vi
      .fn()
      .mockImplementation(async () => ({ leaseId: "apply-lease", approvedAt: new Date().toISOString() })),
    endAgentApply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as DesktopApi;
}

function renderPage(api: DesktopApi, overrides: Partial<React.ComponentProps<typeof AssignmentWorkbench>> = {}) {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() =>
    root.render(
      <I18nProvider>
        <AssignmentWorkbench
          api={api}
          artifactPath="skills/architect"
          packageId="tools"
          packageName="Tools"
          projects={[project]}
          source={source}
          unit={unit}
          onEnsureGrant={vi.fn(async (ref) => (ref.kind === "source" ? "grant-source" : "grant-project"))}
          onNavigate={vi.fn()}
          returnTo={{ screen: "library", tab: "marketplaces" }}
          {...overrides}
        />
      </I18nProvider>,
    ),
  );
  return { container, root };
}

async function selectProjectAndHarness(container: HTMLDivElement): Promise<void> {
  act(() => container.querySelector<HTMLButtonElement>("[data-testid='assignment-project-project-one']")?.click());
  act(() => container.querySelector<HTMLInputElement>("[data-testid='assignment-harness-codex']")?.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await Promise.resolve();
  });
}

describe("assignment immediate apply", () => {
  let rendered: ReturnType<typeof renderPage> | undefined;
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

  it("refuses an unavailable agent request before saving or applying bindings", async () => {
    const api = createApi({
      beginAgentApply: vi.fn().mockRejectedValue(new Error("This request is no longer available; preview it again.")),
    });
    rendered = renderPage(api, { requestId: "unavailable-request" });
    await selectProjectAndHarness(rendered.container);
    await act(async () => {
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-apply-now']")?.click();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("This request is no longer available");
    expect(api.saveBindings).not.toHaveBeenCalled();
    expect(api.runApply).not.toHaveBeenCalled();
    expect(api.resolveAgentRequest).not.toHaveBeenCalled();
  });

  it("saves for later without applying or resolving the agent request", async () => {
    const api = createApi();
    rendered = renderPage(api, { requestId: "request-one" });
    await selectProjectAndHarness(rendered.container);
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-save']")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.saveBindings).toHaveBeenCalledTimes(1);
    expect(api.previewApply).not.toHaveBeenCalled();
    expect(api.runApply).not.toHaveBeenCalled();
    expect(api.resolveAgentRequest).not.toHaveBeenCalled();
  });

  it("applies only selected IDs and resolves a single-project request with its real receipt", async () => {
    const api = createApi();
    rendered = renderPage(api, { requestId: "request-one" });
    await selectProjectAndHarness(rendered.container);
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-apply-now']")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.previewApply).toHaveBeenCalledWith({
      projectId: "project-one",
      grantHandle: "grant-project",
      sourceGrantHandle: "grant-source",
      bindingIds: ["binding-one"],
    });
    expect(api.runApply).toHaveBeenCalledWith({ planId: "apply-one", resolutions: [] });
    expect(api.resolveAgentRequest).toHaveBeenCalledWith({
      requestId: "request-one",
      operationIds: ["receipt-one"],
      approvedAt: expect.any(String),
      leaseId: "apply-lease",
      outcome: { status: "applied" },
    });
    expect(rendered?.container.textContent).toContain("Assignment applied");
  });

  it("completes a two-project agent request with both real receipts", async () => {
    const plans = [
      initialPlan,
      {
        ...initialPlan,
        projectId: "project-two",
        planId: "plan-two",
        actions: [{ ...initialPlan.actions[0]!, bindingId: "binding-two" }],
      },
    ];
    let applied = 0;
    const api = createApi({
      previewBindings: vi.fn().mockResolvedValue({ status: "ready", units, plans }),
      runApply: vi.fn().mockImplementation(async () => ({
        status: "applied",
        receipt: {
          operationId: ++applied === 1 ? "receipt-one" : "receipt-two",
          kind: "apply-plan",
          status: "applied",
          appliedAt: "2026-09-26T10:00:00.000Z",
          displayTarget: applied === 1 ? "Acme Web" : "Notes App",
          actions: [],
          git: { mode: "disabled" },
          registered: null,
        },
      })),
    });
    rendered = renderPage(api, { projects: [project, secondProject], requestId: "request-one" });
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-project-project-two']")?.click(),
    );
    await selectProjectAndHarness(rendered.container);
    await act(async () => {
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-apply-now']")?.click();
      await vi.waitFor(() =>
        expect(api.resolveAgentRequest).toHaveBeenCalledWith({
          requestId: "request-one",
          operationIds: ["receipt-one", "receipt-two"],
          approvedAt: expect.any(String),
          leaseId: "apply-lease",
          outcome: { status: "applied" },
        }),
      );
    });
    expect(api.runApply).toHaveBeenCalledTimes(2);
  });

  it("does not relabel applied files as failed when completion persistence fails", async () => {
    const api = createApi({
      beginAgentApply: vi.fn().mockResolvedValue({ leaseId: "apply-lease", approvedAt: new Date().toISOString() }),
      endAgentApply: vi.fn().mockResolvedValue(undefined),
      resolveAgentRequest: vi.fn().mockRejectedValue(new Error("Receipt storage is unavailable.")),
    });
    rendered = renderPage(api, { requestId: "request-one" });
    await selectProjectAndHarness(rendered.container);
    await act(async () => {
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-apply-now']")?.click();
      await vi.waitFor(() => expect(api.resolveAgentRequest).toHaveBeenCalledOnce());
    });
    expect(rendered?.container.textContent).toContain("Receipt storage is unavailable.");
    expect(api.runApply).toHaveBeenCalledOnce();
    expect(api.resolveAgentRequest).toHaveBeenCalledOnce();
    expect(api.resolveAgentRequest).toHaveBeenCalledWith({
      requestId: "request-one",
      operationIds: ["receipt-one"],
      approvedAt: expect.any(String),
      leaseId: "apply-lease",
      outcome: { status: "applied" },
    });
    expect(api.endAgentApply).toHaveBeenCalledWith({ requestId: "request-one", leaseId: "apply-lease" });
    expect(rendered?.container.textContent).toContain("receipt-one");
  });

  it("keeps applied receipts visible when a later project's preview fails", async () => {
    const plans = [
      initialPlan,
      {
        ...initialPlan,
        projectId: "project-two",
        planId: "plan-two",
        actions: [{ ...initialPlan.actions[0]!, bindingId: "binding-two" }],
      },
    ];
    const api = createApi({
      previewBindings: vi.fn().mockResolvedValue({ status: "ready", units, plans }),
      previewApply: vi
        .fn()
        .mockResolvedValueOnce({
          status: "ready",
          planId: "apply-one",
          actions: [],
          git: { mode: "disabled" },
          project: { displayName: "Acme Web" },
        })
        .mockResolvedValueOnce({ status: "blocked", reason: "Project is unavailable." }),
    });
    rendered = renderPage(api, { projects: [project, secondProject], requestId: "request-one" });
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-project-project-one']")?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-project-project-two']")?.click(),
    );
    act(() => rendered?.container.querySelector<HTMLInputElement>("[data-testid='assignment-harness-codex']")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-apply-now']")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(api.runApply).toHaveBeenCalledTimes(1);
    expect(rendered?.container.textContent).toContain("receipt-one");
    expect(rendered?.container.textContent).toContain("Could not apply changes to Notes App");
    expect(rendered?.container.textContent).toContain("partial apply");
    expect(api.resolveAgentRequest).toHaveBeenCalledWith({
      requestId: "request-one",
      operationIds: ["receipt-one"],
      approvedAt: expect.any(String),
      leaseId: "apply-lease",
      outcome: { status: "failed", message: "Project is unavailable." },
    });
  });

  it("shows and opens a failed apply receipt", async () => {
    const failedReceipt = {
      operationId: "failed-receipt",
      kind: "apply-plan",
      status: "failed",
      appliedAt: "2026-09-26T10:00:00.000Z",
      displayTarget: "Acme Web",
      actions: [],
      git: { mode: "disabled" },
      registered: null,
      diagnostic: "Write failed.",
    } as const;
    const api = createApi({ runApply: vi.fn().mockResolvedValue({ status: "failed", receipt: failedReceipt }) });
    const onNavigate = vi.fn();
    rendered = renderPage(api, { onNavigate, requestId: "request-one" });
    await selectProjectAndHarness(rendered.container);
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-apply-now']")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-failed-receipt-open']")?.click(),
    );
    expect(api.resolveAgentRequest).toHaveBeenCalledWith({
      requestId: "request-one",
      operationIds: ["failed-receipt"],
      approvedAt: expect.any(String),
      leaseId: "apply-lease",
      outcome: { status: "failed", message: "Write failed." },
    });
    expect(rendered?.container.textContent).toContain("failed-receipt");
    expect(rendered?.container.textContent).toContain("no project was applied");
    expect(onNavigate).toHaveBeenCalledWith({
      screen: "operation-receipt",
      operationId: "failed-receipt",
      returnTo: { screen: "library", tab: "marketplaces" },
    });
  });

  it("offers conflict resolution with only selected binding IDs", async () => {
    const api = createApi({
      beginAgentApply: vi.fn().mockResolvedValue({ leaseId: "apply-lease", approvedAt: new Date().toISOString() }),
      endAgentApply: vi.fn().mockResolvedValue(undefined),
      previewApply: vi.fn().mockResolvedValue({
        status: "ready",
        planId: "apply-one",
        actions: [
          {
            actionId: "action-one",
            bindingId: "binding-one",
            harnessId: "codex",
            kind: "skill",
            relativePath: ".agents/skills/architect",
            state: "conflict",
            needsResolution: true,
          },
        ],
        git: { mode: "disabled" },
        project: { displayName: "Acme Web" },
      }),
    });
    const onNavigate = vi.fn();
    rendered = renderPage(api, { onNavigate, requestId: "request-one" });
    await selectProjectAndHarness(rendered.container);
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-apply-now']")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-resolve-conflict']")?.click(),
    );
    expect(api.runApply).not.toHaveBeenCalled();
    expect(api.resolveAgentRequest).not.toHaveBeenCalled();
    expect(api.endAgentApply).toHaveBeenCalledWith({ requestId: "request-one", leaseId: "apply-lease" });
    expect(onNavigate).toHaveBeenCalledWith({
      screen: "operation-apply",
      projectId: "project-one",
      bindingIds: ["binding-one"],
    });
  });

  it("stops before saving when the fresh preview has changed", async () => {
    const changed = createApi({
      previewBindings: vi
        .fn()
        .mockResolvedValueOnce({ status: "ready", units, plans: [initialPlan] })
        .mockResolvedValueOnce({
          status: "ready",
          units: [{ ...units[0]!, contentHash: "b".repeat(64) }],
          plans: [{ ...initialPlan, planId: "changed-plan" }],
        }),
    });
    rendered = renderPage(changed);
    await selectProjectAndHarness(rendered.container);
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-apply-now']")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(changed.saveBindings).not.toHaveBeenCalled();
    expect(rendered?.container.textContent).toContain("preview for Acme Web changed");
  });

  it("preserves owned hash, bound hash and creation time for an existing binding", () => {
    const prior = {
      ...baseline,
      ownedHash: "b".repeat(64),
      boundHash: "c".repeat(64),
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    expect(buildBindingsToSave([initialPlan], units, source, "tools", [prior])).toEqual([prior]);
  });

  it("keeps project-origin back navigation in Projects", () => {
    const returnTo = {
      screen: "asset" as const,
      artifactId: "skill:architect",
      from: { kind: "project" as const, projectId: "project-one" },
    };
    expect(rootDestination({ screen: "assignment", sourceId: "personal", packageId: "tools", returnTo })).toBe(
      "projects",
    );
    const onNavigate = vi.fn();
    rendered = renderPage(createApi(), { returnTo, onNavigate });
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-back']")?.click());
    expect(onNavigate).toHaveBeenCalledWith(returnTo);
  });
  it("keeps the project name and Projects destination when entered through Add from library", () => {
    const returnTo = { screen: "project-add" as const, projectId: "project-one" };
    expect(rootDestination({ screen: "assignment", sourceId: "personal", packageId: "tools", returnTo })).toBe(
      "projects",
    );
    rendered = renderPage(createApi(), { returnTo });
    expect(rendered.container.querySelector('[aria-label="Breadcrumb"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="changes-workbench"]')).not.toBeNull();
  });
});
