// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ObservedArtifact } from "../../src/domain/inventory";
import type { EntryRef, Observation, RegistryView } from "../../src/domain/project-source-registry";
import { I18nProvider } from "../../src/renderer/i18n";
import { rootDestination, type Route } from "../../src/renderer/navigation";
import { ImportWorkbench } from "../../src/renderer/canvas/changes/ImportWorkbench";
import { RestoreWorkbench } from "../../src/renderer/canvas/changes/RestoreWorkbench";
import { SettingsSections } from "../../src/renderer/settings/SettingsSections";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationReceipt } from "../../src/shared/operations-ipc";

import {
  project,
  personal,
  external,
  source,
  artifact,
  personalObservation,
  registry,
  returnTo,
  render,
  readyPlan,
} from "./brief-12-import-helpers";

describe("Brief 12 import and capture renderer", () => {
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

  it("shows a blocked preview without an apply action", async () => {
    const api = {
      previewOperation: vi.fn().mockResolvedValue({
        status: "blocked",
        reason: "Duplicate artifact",
        diagnostic: "The same content already exists in pstack.",
      }),
    } as unknown as DesktopApi;
    rendered = render(
      <ImportWorkbench
        api={api}
        artifact={artifact}
        origin={source}
        originName={external.displayName}
        targetObservation={personalObservation}
        sourceGrantHandle="source-grant"
        returnTo={returnTo}
        onMarketplaceChanged={vi.fn()}
        onNavigateToRoute={vi.fn()}
      />,
    );
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='import-target-pstack']")?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Duplicate artifact");
    expect(rendered.container.querySelector("[data-testid='import-apply']")).toBeNull();
  });

  it("previews and applies restore, then returns to Review", async () => {
    const receipt: OperationReceipt = {
      operationId: "import-one",
      kind: "import-artifact",
      status: "applied",
      appliedAt: "2026-09-13T10:00:00.000Z",
      displayTarget: "my-marketplace/packages/pstack",
      actions: [],
      git: { mode: "commit", commit: "abcdef1234567" },
      registered: null,
      source: { kind: "source", id: source.id, relativePath: artifact.relativePath },
      files: [{ relativePath: artifact.relativePath, contentHash: "a".repeat(64) }],
      manifests: [],
    };
    const api = {
      listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [receipt] }),
      previewOperation: vi.fn().mockResolvedValue({
        status: "ready",
        plan: {
          planId: "restore-plan",
          kind: "restore-import",
          displayTarget: receipt.displayTarget,
          actions: [{ kind: "delete-file", relativePath: artifact.relativePath }],
          git: { mode: "commit", warnings: [] },
        },
      }),
      applyOperation: vi.fn().mockResolvedValue({
        status: "applied",
        receipt: { ...receipt, operationId: "restore-one", kind: "restore-import", restores: receipt.operationId },
      }),
    } as unknown as DesktopApi;
    const onNavigateToRoute = vi.fn();
    rendered = render(
      <RestoreWorkbench
        api={api}
        operationId={receipt.operationId}
        onMarketplaceChanged={vi.fn()}
        onNavigateToRoute={onNavigateToRoute}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Restore");
    const files = rendered.container.querySelector("[data-testid='restore-file-list']");
    expect(files).not.toBeNull();
    expect(files?.closest("[hidden]")).toBeNull();
    expect(files?.textContent).toContain(artifact.relativePath);
    expect(rendered.container.querySelector("[role='tab'][aria-selected='true']")?.textContent).toBe("Preview");
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='restore-apply']")?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='restore-result']")).toBeTruthy();
    expect(rendered.container.querySelector("[data-testid='restore-file-list']")).toBeNull();
    expect(rendered.container.textContent).not.toContain("Loading restore preview");
    expect(rendered.container.querySelector("[data-testid='restore-result-footer']")).not.toBeNull();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='restore-back']")?.click());
    expect(onNavigateToRoute).toHaveBeenCalledWith({ screen: "review" });
  });

  it("renders operation paths as facts in Settings", async () => {
    const api = {
      getOperationPaths: vi.fn().mockResolvedValue({
        marketplace: { displayRoot: "~/Library/marketplace" },
        store: { displayRoot: "~/Library/operations" },
      }),
    } as unknown as DesktopApi;
    rendered = render(<SettingsSections api={api} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("~/Library/marketplace");
    expect(rendered.container.textContent).toContain("~/Library/operations");
  });

  it("shows an absolute marketplace path supplied to Settings before operation paths load", () => {
    rendered = render(<SettingsSections marketplace={{ name: "Demo", path: "/private/tmp/demo/acme-skills" }} />);
    expect(rendered.container.textContent).toContain("/private/tmp/demo/acme-skills");
  });
});
