// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreateMarketplaceFlow } from "../../src/renderer/operations/CreateMarketplaceFlow";
import { I18nProvider } from "../../src/renderer/i18n";
import type { DesktopApi } from "../../src/shared/ipc";

function render(api: DesktopApi): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() =>
    root.render(
      <I18nProvider>
        <CreateMarketplaceFlow api={api} onApplied={vi.fn()} />
      </I18nProvider>,
    ),
  );
  return { container, root };
}

describe("CreateMarketplaceFlow", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

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

  it("chooses a parent, previews exact actions, then applies and reports the receipt", async () => {
    const api = {
      pickOperationParent: vi
        .fn()
        .mockResolvedValue({ status: "picked", parentToken: "parent-token", displayParent: "scratch" }),
      previewOperation: vi.fn().mockResolvedValue({
        status: "ready",
        plan: {
          planId: "plan-one",
          kind: "create-marketplace",
          displayTarget: "my-marketplace",
          actions: [
            { kind: "create-directory", relativePath: "." },
            { kind: "write-file", relativePath: "omni.marketplace.json", byteLength: 200 },
          ],
          git: { mode: "init-and-commit", warnings: [] },
        },
      }),
      applyOperation: vi.fn().mockResolvedValue({
        status: "applied",
        receipt: {
          operationId: "operation-one",
          kind: "create-marketplace",
          status: "applied",
          appliedAt: "2026-09-12T10:00:00.000Z",
          displayTarget: "my-marketplace",
          actions: [],
          git: { mode: "init-and-commit", commit: "abcdef1234567" },
          registered: { sourceId: "source-one" },
        },
      }),
    } as unknown as DesktopApi;
    const onApplied = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.append(container);
    act(() =>
      root.render(
        <I18nProvider>
          <CreateMarketplaceFlow api={api} onApplied={onApplied} />
        </I18nProvider>,
      ),
    );
    rendered = { container, root };

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='create-marketplace-pick-parent']")?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain("scratch");
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='create-marketplace-preview']")?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.previewOperation).toHaveBeenCalledWith({
      kind: "create-marketplace",
      parentToken: "parent-token",
      name: "my-marketplace",
    });
    expect(container.textContent).toContain("omni.marketplace.json");
    expect(container.textContent).toContain("initialise and commit");
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='create-marketplace-apply']")?.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.applyOperation).toHaveBeenCalledWith({ planId: "plan-one" });
    expect(onApplied).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Marketplace created");
  });

  it("disables creation when a personal source is active", () => {
    const api = {} as DesktopApi;
    const container = document.createElement("div");
    const root = createRoot(container);
    document.body.append(container);
    act(() =>
      root.render(
        <I18nProvider>
          <CreateMarketplaceFlow activePersonalSource api={api} onApplied={vi.fn()} />
        </I18nProvider>,
      ),
    );
    rendered = { container, root };
    act(() =>
      rendered!.container.querySelector<HTMLButtonElement>("[data-testid='create-marketplace-pick-parent']")?.click(),
    );
    expect(rendered!.container.textContent).toContain("Archive the active personal marketplace first");
  });

  it("renders a blocked preview as a diagnostic without an apply action", async () => {
    const api = {
      pickOperationParent: vi
        .fn()
        .mockResolvedValue({ status: "picked", parentToken: "parent-token", displayParent: "scratch" }),
      previewOperation: vi.fn().mockResolvedValue({
        status: "blocked",
        reason: "target-not-empty",
        diagnostic: "The target folder already contains files.",
      }),
    } as unknown as DesktopApi;
    rendered = render(api);
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='create-marketplace-pick-parent']")?.click(),
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='create-marketplace-preview']")?.click(),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered?.container.textContent).toContain("target-not-empty");
    expect(rendered?.container.querySelector("[data-testid='marketplace-create-apply']")).toBeNull();
  });
});
