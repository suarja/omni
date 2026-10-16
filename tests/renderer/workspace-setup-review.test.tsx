// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { AppShell } from "../../src/renderer/shell/AppShell";
import type { AppShellProps } from "../../src/renderer/shell/routes";
import { I18nProvider } from "../../src/renderer/i18n";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationPlan, OperationReceipt } from "../../src/shared/operations-ipc";
import {
  createCanvasRoot,
  project,
  registryView,
  renderResourceCanvas,
  resourceSnapshot,
  setupInputs,
  source,
} from "./workspace-setup-fixtures";

const plan: OperationPlan = {
  planId: "review-plan",
  kind: "create-marketplace",
  displayTarget: "Scratch/skills",
  actions: [{ kind: "create-directory", relativePath: "." }],
  git: { mode: "not-a-repository", warnings: [] },
};
const receipt: OperationReceipt = {
  operationId: "review-operation",
  kind: "create-marketplace",
  status: "applied",
  appliedAt: "2026-10-04T12:00:00.000Z",
  displayTarget: "Scratch/skills",
  actions: [{ kind: "create-directory", relativePath: ".", status: "applied" }],
  git: { mode: "not-a-repository" },
  registered: { sourceId: "created-source" },
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function shellProps(setup: ReturnType<typeof setupInputs>, onBack: () => void): AppShellProps {
  const audit: AppShellProps["destinationAudit"] = {
    status: "completed",
    progress: { completed: 0, total: 0 },
    report: { observations: [], findings: [], unavailable: [] },
    error: null,
    start: vi.fn(),
    cancel: vi.fn(),
    refresh: vi.fn(),
  };
  return {
    api: null,
    route: { screen: "resource-canvas", context: { kind: "workspace" } },
    mode: "light",
    canGoBack: true,
    onBack,
    resourceSnapshot: setup.snapshot,
    setup,
    registry: { status: "ready", registry: setup.snapshot.registry },
    destinationAudit: audit,
    destinationObservation: null,
    registryBusy: false,
    registryMutationBusy: false,
    registryError: null,
    openedEntry: null,
    onModeChange: vi.fn(),
    onNavigate: vi.fn(),
    onNavigateToRoute: vi.fn(),
    onReaudit: vi.fn(),
    onRefreshRegistry: vi.fn(async () => null),
    onRetry: vi.fn(),
  };
}

describe("workspace setup review regressions", () => {
  let rendered: ReturnType<typeof createCanvasRoot>;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rendered = createCanvasRoot();
  });
  afterEach(() => {
    act(() => rendered.root.unmount());
    vi.restoreAllMocks();
  });

  function click(selector: string): void {
    const button = rendered.container.querySelector<HTMLButtonElement>(selector);
    expect(button, selector).not.toBeNull();
    act(() => button!.click());
  }

  async function openCreate(setup: ReturnType<typeof setupInputs>): Promise<void> {
    const api = setup.api as Required<Pick<DesktopApi, "pickOperationParent" | "previewOperation">>;
    vi.spyOn(api, "pickOperationParent").mockResolvedValue({
      status: "picked",
      parentToken: "parent",
      displayParent: "Scratch",
    });
    vi.spyOn(api, "previewOperation").mockResolvedValue({ status: "ready", plan });
    if (rendered.container.querySelector("[data-testid='canvas-setup-empty-marketplace']"))
      click("[data-testid='canvas-setup-empty-marketplace']");
    else {
      click("[data-testid='canvas-setup-menu-trigger']");
      click(".canvas-setup-menu button:nth-child(2)");
    }
    click("[data-testid='canvas-setup-choice-existing']");
    click("[data-testid='canvas-setup-choice-create']");
    await flush();
    click("[data-testid='canvas-setup-marketplace-pick-parent']");
    await flush();
    click("[data-testid='canvas-setup-marketplace-preview']");
    await flush();
  }

  it("keeps the active write visible when a background destination is clicked", async () => {
    const setup = setupInputs({ snapshot: resourceSnapshot(registryView([project("write-project")])) });
    let finish!: (value: { status: "applied"; receipt: OperationReceipt }) => void;
    const pendingApply = new Promise<{ status: "applied"; receipt: OperationReceipt }>((resolve) => {
      finish = resolve;
    });
    const api = setup.api as Required<Pick<DesktopApi, "applyOperation">>;
    vi.spyOn(api, "applyOperation").mockReturnValue(pendingApply);
    const navigate = vi.fn();
    const onNavigate = vi.fn();
    const onRefresh = vi.fn();
    await act(async () =>
      rendered.root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={null}
            context={{ kind: "workspace" }}
            onEnsureGrant={async () => null}
            onNavigate={onNavigate}
            onNavigateDestination={navigate}
            onRefresh={onRefresh}
            setup={setup}
            snapshot={setup.snapshot}
          />
        </I18nProvider>,
      ),
    );
    await openCreate(setup);
    click("[data-testid='canvas-setup-marketplace-apply']");
    await flush();
    click(".canvas-rail-button[aria-label='Review']");
    click(".canvas-breadcrumbs button:first-child");
    click(".canvas-node[data-kind='project']");
    click(".canvas-search-trigger");
    click(".canvas-icon-button[aria-label='Refresh']");
    click("[data-testid='canvas-setup-sheet'] .canvas-sheet-header button");
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })),
    );
    expect(rendered.container.querySelector(".canvas-search-sheet")).toBeNull();
    const callsDuringWrite = navigate.mock.calls.length;
    await act(async () => finish({ status: "applied", receipt }));
    await flush();
    expect(callsDuringWrite).toBe(0);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("blocks global Back shortcuts during a write and restores them afterward", async () => {
    const setup = setupInputs();
    let finish!: (value: { status: "applied"; receipt: OperationReceipt }) => void;
    const pending = new Promise<{ status: "applied"; receipt: OperationReceipt }>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(setup.api as Required<Pick<DesktopApi, "applyOperation">>, "applyOperation").mockReturnValue(pending);
    const onBack = vi.fn();
    await act(async () =>
      rendered.root.render(
        <I18nProvider initialLanguage="en">
          <AppShell {...shellProps(setup, onBack)} />
        </I18nProvider>,
      ),
    );
    await openCreate(setup);
    click("[data-testid='canvas-setup-marketplace-apply']");
    await flush();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true }));
    });
    expect(onBack).not.toHaveBeenCalled();
    await act(async () => finish({ status: "applied", receipt }));
    await flush();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true })));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("shows one completion action after creating and reading a marketplace", async () => {
    const setup = setupInputs();
    const api = setup.api as Required<Pick<DesktopApi, "applyOperation">>;
    vi.spyOn(api, "applyOperation").mockResolvedValue({ status: "applied", receipt });
    await act(async () => renderResourceCanvas(rendered.root, setup));
    await openCreate(setup);
    click("[data-testid='canvas-setup-marketplace-apply']");
    await flush();
    const created = source("created-source", "Skills");
    await act(async () =>
      renderResourceCanvas(rendered.root, {
        ...setup,
        snapshot: resourceSnapshot(registryView([], [created]), [created.ref]),
      }),
    );
    await flush();
    const done = [
      ...rendered.container.querySelectorAll<HTMLButtonElement>("[data-testid='canvas-setup-sheet'] button"),
    ].filter((button) => button.textContent === "Done");
    expect(done).toHaveLength(1);
    expect(rendered.container.querySelector("[data-testid='canvas-setup-marketplace-name']")).toBeNull();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-marketplace-preview']")).toBeNull();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-marketplace-apply']")).toBeNull();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-add-project']")).not.toBeNull();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-connect-agents']")).toBeNull();
  });

  it("keeps the operation receipt inspectable when registry refresh fails", async () => {
    const setup = setupInputs();
    vi.spyOn(setup.api as Required<Pick<DesktopApi, "applyOperation">>, "applyOperation").mockResolvedValue({
      status: "applied",
      receipt,
    });
    vi.spyOn(setup.commands, "refreshRegistry").mockRejectedValue(new Error("temporary refresh failure"));
    await act(async () => renderResourceCanvas(rendered.root, setup));
    await openCreate(setup);
    click("[data-testid='canvas-setup-marketplace-apply']");
    await flush();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-registration-result'] details")).not.toBeNull();
    expect(rendered.container.textContent).toContain("workspace could not be refreshed");
    expect(rendered.container.querySelector("[data-testid='canvas-setup-create-form']")).toBeNull();
    expect(rendered.container.querySelector("[data-testid='canvas-setup-marketplace-apply']")).toBeNull();
  });

  it("reports partial inventory without counting resources that were not observed", async () => {
    const setup = setupInputs();
    const entry = project("partial-project", "Partial project");
    const snapshot = resourceSnapshot(registryView([entry]), [entry.ref]);
    const partialSnapshot = {
      ...snapshot,
      roots: snapshot.roots.map((root) => ({
        ...root,
        evidence:
          root.evidence.status === "observed"
            ? {
                ...root.evidence,
                observation: {
                  ...root.evidence.observation,
                  inventory: {
                    ...root.evidence.observation.inventory,
                    diagnostics: [
                      {
                        code: "inaccessible" as const,
                        severity: "warning" as const,
                        location: "private-entry",
                        message: "not shown",
                      },
                    ],
                  },
                },
              }
            : root.evidence,
      })),
    };
    const registerProject = vi.spyOn(setup.commands, "registerProject").mockResolvedValue({
      status: "ready",
      outcome: "created",
      entry,
      grantHandle: "grant",
      registryRevision: 2,
    });
    await act(async () => renderResourceCanvas(rendered.root, setup));
    click("[data-testid='canvas-setup-empty-project']");
    click("[data-testid='canvas-setup-inspect-project']");
    await flush();
    click("[data-testid='canvas-setup-register-project']");
    await flush();
    await act(async () => renderResourceCanvas(rendered.root, { ...setup, snapshot: partialSnapshot }));
    await flush();
    expect(registerProject).toHaveBeenCalledTimes(1);
    expect(rendered.container.querySelector("[data-testid='canvas-setup-observed-summary']")?.textContent).toContain(
      "Partial inventory · 0 resources observed",
    );
    expect(rendered.container.textContent).not.toContain("Observed resources: 1");
  });
});
