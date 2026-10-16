// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../../src/renderer/i18n";
import { useMarketplaceCreation } from "../../src/renderer/operations/use-marketplace-creation";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationPlan, OperationReceipt } from "../../src/shared/operations-ipc";

const plan: OperationPlan = {
  planId: "create-plan",
  kind: "create-marketplace",
  displayTarget: "scratch/my-marketplace",
  actions: [{ kind: "create-directory", relativePath: "." }],
  git: { mode: "not-a-repository", warnings: [] },
};

const appliedReceipt: OperationReceipt = {
  operationId: "create-operation",
  kind: "create-marketplace",
  status: "applied",
  appliedAt: "2026-10-04T10:00:00.000Z",
  displayTarget: "scratch/my-marketplace",
  actions: [{ kind: "create-directory", relativePath: ".", status: "applied" }],
  git: { mode: "not-a-repository" },
  registered: { sourceId: "source-created" },
};

const failedReceipt: OperationReceipt = {
  ...appliedReceipt,
  operationId: "create-operation-failed",
  status: "failed",
  registered: null,
  diagnostic: "The operation was rolled back.",
};

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

type Controller = ReturnType<typeof useMarketplaceCreation>;
let controller: Controller | null = null;

function Harness({ api, onApplied }: Readonly<{ api: DesktopApi; onApplied: (receipt: OperationReceipt) => void }>) {
  controller = useMarketplaceCreation({ api, onApplied });
  return null;
}

function mount(api: DesktopApi, onApplied = vi.fn()): Readonly<{ root: Root; onApplied: typeof onApplied }> {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() =>
    root.render(
      <I18nProvider>
        <Harness api={api} onApplied={onApplied} />
      </I18nProvider>,
    ),
  );
  return { root, onApplied };
}

function current(): Controller {
  if (!controller) throw new Error("Marketplace creation controller is not mounted.");
  return controller;
}

async function selectParent(): Promise<void> {
  await act(async () => current().actions.chooseParent());
}

async function showPreview(): Promise<void> {
  await selectParent();
  await act(async () => current().actions.preview());
}

describe("marketplace creation controller", () => {
  let mounted: Readonly<{ root: Root; onApplied: (receipt: OperationReceipt) => void }> | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    controller = null;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => mounted?.root.unmount());
    mounted = undefined;
    controller = null;
    vi.restoreAllMocks();
  });

  it("does not publish a preview after its name intent changes", async () => {
    const pending = deferred<{ status: "ready"; plan: OperationPlan }>();
    const api = {
      pickOperationParent: vi
        .fn()
        .mockResolvedValue({ status: "picked", parentToken: "parent-a", displayParent: "scratch" }),
      previewOperation: vi.fn(() => pending.promise),
    } as unknown as DesktopApi;
    mounted = mount(api);
    await selectParent();

    let previewRequest!: Promise<void>;
    act(() => {
      previewRequest = current().actions.preview();
    });
    act(() => current().actions.setName("renamed-marketplace"));
    await act(async () => {
      pending.resolve({ status: "ready", plan });
      await previewRequest;
    });

    expect(api.previewOperation).toHaveBeenCalledWith({
      kind: "create-marketplace",
      parentToken: "parent-a",
      name: "my-marketplace",
    });
    expect(current().state.preview).toBeNull();
  });

  it("invalidates the displayed preview when the parent token changes", async () => {
    const api = {
      pickOperationParent: vi
        .fn()
        .mockResolvedValueOnce({ status: "picked", parentToken: "parent-a", displayParent: "first" })
        .mockResolvedValueOnce({ status: "picked", parentToken: "parent-b", displayParent: "second" }),
      previewOperation: vi.fn().mockResolvedValue({ status: "ready", plan }),
    } as unknown as DesktopApi;
    mounted = mount(api);
    await showPreview();
    expect(current().state.preview?.kind).toBe("ready");

    await selectParent();

    expect(current().state.parent?.token).toBe("parent-b");
    expect(current().state.preview).toBeNull();
  });

  it("blocks two same-tick applies for the same displayed plan", async () => {
    const applying = deferred<{ status: "applied"; receipt: OperationReceipt }>();
    const api = {
      pickOperationParent: vi
        .fn()
        .mockResolvedValue({ status: "picked", parentToken: "parent-a", displayParent: "scratch" }),
      previewOperation: vi.fn().mockResolvedValue({ status: "ready", plan }),
      applyOperation: vi.fn(() => applying.promise),
    } as unknown as DesktopApi;
    mounted = mount(api);
    await showPreview();

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = current().actions.apply();
      second = current().actions.apply();
    });
    await act(async () => {
      applying.resolve({ status: "applied", receipt: appliedReceipt });
      await Promise.all([first, second]);
    });

    expect(api.applyOperation).toHaveBeenCalledTimes(1);
    expect(mounted.onApplied).toHaveBeenCalledWith(appliedReceipt);
  });

  it("retains the failed receipt and diagnostic for recovery", async () => {
    const api = {
      pickOperationParent: vi
        .fn()
        .mockResolvedValue({ status: "picked", parentToken: "parent-a", displayParent: "scratch" }),
      previewOperation: vi.fn().mockResolvedValue({ status: "ready", plan }),
      applyOperation: vi.fn().mockResolvedValue({ status: "failed", receipt: failedReceipt }),
    } as unknown as DesktopApi;
    mounted = mount(api);
    await showPreview();
    await act(async () => current().actions.apply());

    expect(current().state.receipt).toEqual(failedReceipt);
    expect(current().state.diagnostic).toContain("rolled back");
    expect(mounted.onApplied).not.toHaveBeenCalled();
  });

  it("does not report creation when the applied receipt has no registered source", async () => {
    const receiptWithoutRegistration = { ...appliedReceipt, registered: null };
    const api = {
      pickOperationParent: vi
        .fn()
        .mockResolvedValue({ status: "picked", parentToken: "parent-a", displayParent: "scratch" }),
      previewOperation: vi.fn().mockResolvedValue({ status: "ready", plan }),
      applyOperation: vi.fn().mockResolvedValue({ status: "applied", receipt: receiptWithoutRegistration }),
    } as unknown as DesktopApi;
    mounted = mount(api);
    await showPreview();
    await act(async () => current().actions.apply());

    expect(current().state.receipt).toEqual(receiptWithoutRegistration);
    expect(current().state.registered).toBe(false);
    expect(current().state.diagnostic).not.toBeNull();
    expect(mounted.onApplied).not.toHaveBeenCalled();
  });

  it("does not publish an apply result after the presentation unmounts", async () => {
    const applying = deferred<{ status: "applied"; receipt: OperationReceipt }>();
    const api = {
      pickOperationParent: vi
        .fn()
        .mockResolvedValue({ status: "picked", parentToken: "parent-a", displayParent: "scratch" }),
      previewOperation: vi.fn().mockResolvedValue({ status: "ready", plan }),
      applyOperation: vi.fn(() => applying.promise),
    } as unknown as DesktopApi;
    mounted = mount(api);
    await showPreview();

    let applyRequest!: Promise<void>;
    act(() => {
      applyRequest = current().actions.apply();
    });
    act(() => mounted?.root.unmount());
    await act(async () => {
      applying.resolve({ status: "applied", receipt: appliedReceipt });
      await applyRequest;
    });

    expect(mounted.onApplied).not.toHaveBeenCalled();
  });
});
