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

  it("opens a recomputed agent capture and resolves the original request after approval", async () => {
    const original = readyPlan().plan;
    const updated = {
      ...original,
      planId: "updated-capture",
      actions: [...original.actions, { kind: "write-file", relativePath: "new.md", afterHash: "a".repeat(64) }],
    };
    const pending = {
      requestId: "capture-one",
      createdAt: "2026-10-11T00:00:00Z",
      approval: "omni",
      status: "pending",
      request: {
        kind: "import-artifact",
        projectId: project.ref.id,
        relativePath: artifact.relativePath,
        target: { sourceId: personal.ref.id, packageId: "pstack" },
      },
      plan: original,
    };
    const refreshAgentRequest = vi.fn(async () => ({ ...pending, plan: updated }));
    const applyOperation = vi.fn(async () => ({
      status: "applied",
      receipt: {
        operationId: "capture-receipt",
        displayTarget: "packages/pstack",
        appliedAt: "2026-10-11T00:00:00Z",
        kind: "import-artifact",
        status: "applied",
        actions: [],
        files: [],
        manifests: [],
        git: { mode: "unavailable" },
      },
    }));
    const resolveAgentRequest = vi.fn();
    const api = {
      listAgentRequests: vi.fn(async () => ({ requests: [pending] })),
      refreshAgentRequest,
      applyOperation,
      resolveAgentRequest,
    } as unknown as DesktopApi;
    rendered = render(
      <ImportWorkbench
        api={api}
        artifact={artifact}
        origin={project.ref}
        originName="Project"
        sourceGrantHandle="project-grant"
        targetObservation={personalObservation}
        returnTo={{ screen: "review" }}
        requestId="capture-one"
        onNavigateToRoute={vi.fn()}
        onMarketplaceChanged={vi.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(refreshAgentRequest).toHaveBeenCalledWith("capture-one");
    expect(rendered.container.textContent).toContain("Files changed since the agent asked");
    const button = rendered.container.querySelector<HTMLButtonElement>("[data-testid='import-apply']");
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(applyOperation).toHaveBeenCalledWith({ planId: "updated-capture" });
    expect(resolveAgentRequest).toHaveBeenCalledWith({ requestId: "capture-one", operationId: "capture-receipt" });
  });

  it("maps operation routes to the origin and review roots", () => {
    expect(
      rootDestination({
        screen: "operation-import",
        source: project.ref,
        relativePath: "skills/review/SKILL.md",
        returnTo: { screen: "project", projectId: project.ref.id, tab: "context" },
      }),
    ).toBe("projects");
    expect(rootDestination({ screen: "operation-import", source, relativePath: artifact.relativePath, returnTo })).toBe(
      "library",
    );
    expect(rootDestination({ screen: "operation-restore", operationId: "operation-one" })).toBe("review");
  });

  it("selects nothing until the user picks a package", () => {
    const api = { previewOperation: vi.fn() } as unknown as DesktopApi;
    rendered = render(
      <ImportWorkbench
        api={api}
        artifact={artifact}
        origin={source}
        originName={external.displayName}
        targetObservation={personalObservation}
        sourceGrantHandle="source-grant"
        returnTo={{ screen: "library", tab: "marketplaces" }}
        onNavigateToRoute={vi.fn()}
        onMarketplaceChanged={vi.fn()}
      />,
    );
    expect(rendered.container.querySelectorAll("[aria-pressed='true']")).toHaveLength(0);
    expect(rendered.container.querySelector("[data-testid='import-target-pstack'] .ui-item__chevron")).toBeNull();
    expect(api.previewOperation).not.toHaveBeenCalled();
  });

  it("previews a chosen package and applies the import", async () => {
    const previewOperation = vi.fn().mockResolvedValue(readyPlan());
    const applyOperation = vi.fn().mockResolvedValue({
      status: "applied",
      receipt: {
        operationId: "operation-one",
        kind: "import-artifact",
        status: "applied",
        appliedAt: "2026-09-13T10:00:00.000Z",
        displayTarget: "packages/pstack",
        actions: [],
        git: { mode: "commit", commit: "abcdef1234567" },
        registered: null,
        source: { kind: "source", id: source.id, relativePath: artifact.relativePath },
        files: [
          { relativePath: "packages/pstack/skills/review/SKILL.md", contentHash: "a".repeat(64) },
          {
            relativePath: "packages/pstack/skills/review/references/migration-patterns.md",
            contentHash: "b".repeat(64),
          },
        ],
        manifests: [],
      } satisfies OperationReceipt,
    });
    const onNavigateToRoute = vi.fn();
    const onMarketplaceChanged = vi.fn();
    const api = { previewOperation, applyOperation } as unknown as DesktopApi;
    rendered = render(
      <ImportWorkbench
        api={api}
        artifact={artifact}
        origin={source}
        originName={external.displayName}
        targetObservation={personalObservation}
        sourceGrantHandle="source-grant"
        returnTo={returnTo}
        onMarketplaceChanged={onMarketplaceChanged}
        onNavigateToRoute={onNavigateToRoute}
      />,
    );

    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='import-target-pstack']")?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(previewOperation).toHaveBeenCalledWith({
      kind: "import-artifact",
      source: { kind: "source", id: source.id, grantHandle: "source-grant" },
      relativePath: artifact.relativePath,
      target: { packageId: "pstack" },
    });
    expect(rendered.container.textContent).toContain("review → pstack");
    expect(rendered.container.querySelector("[data-testid='import-target-pstack']")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(rendered.container.textContent).toContain("Nothing is written before you confirm.");
    expect(rendered.container.textContent).toContain("2 files · 2.0 KB");
    expect(rendered.container.querySelector("[data-testid='import-file-list']")?.textContent).toContain("SKILL.md");
    expect(rendered.container.querySelector("[data-testid='import-file-list']")?.textContent).toContain(
      "references/migration-patterns.md",
    );
    expect(rendered.container.querySelector("[data-testid='import-file-list']")?.textContent).not.toContain(
      "packages/pstack",
    );
    expect(rendered.container.textContent).toContain("omni.plugin.json · omni.marketplace.json");
    expect(rendered.container.textContent).toContain("One commit in My marketplace");
    expect(rendered.container.textContent).toContain("Claude Code");
    act(() => rendered?.container.querySelector<HTMLButtonElement>("#changes-tab-targets")?.click());
    expect(rendered?.container.querySelector("[data-testid='import-apply']")?.closest("[hidden]")).toBeNull();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='import-apply']")?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onMarketplaceChanged).toHaveBeenCalledOnce();
    expect(rendered.container.querySelector("[data-testid='import-result']")?.textContent).toContain(
      "2 files written in pstack",
    );
    expect(rendered.container.querySelector("[data-testid='import-result']")?.textContent).toContain("abcdef1");
    expect(rendered.container.querySelector("[data-testid='import-result']")?.textContent).toContain("Claude Code");
    expect(rendered.container.querySelector("[data-testid='import-target-pstack']")).toBeNull();
    expect(rendered.container.querySelector("[data-testid='import-result-footer']")).not.toBeNull();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='import-result-open']")?.click());
    expect(onNavigateToRoute).toHaveBeenCalledWith({
      screen: "package",
      sourceId: personal.ref.id,
      packageId: "pstack",
    });
  });

  it("shows the artifact name and preferred Claude projection in the workbench header", () => {
    rendered = render(
      <ImportWorkbench
        api={null}
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
    expect(rendered.container.querySelector(".changes-header h2")?.textContent).toBe("Import review");
    expect(rendered.container.querySelector(".changes-header .sh-sub")?.textContent).toContain(
      "Skill · Community source · .claude/skills/review/SKILL.md",
    );
    expect(rendered.container.textContent).not.toContain("Where");
    expect(rendered.container.querySelector(".ui-breadcrumbs")).toBeNull();
  });

  it("excludes package manifests from the package asset count", () => {
    rendered = render(
      <ImportWorkbench
        api={null}
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
    expect(rendered.container.querySelector("[data-testid='import-target-pstack']")?.textContent).toContain("1 asset");
    expect(rendered.container.querySelector("[data-testid='import-target-pstack']")?.textContent).not.toContain(
      "2 assets",
    );
  });

  it("sends default harness projections for a new package", async () => {
    const previewOperation = vi.fn().mockResolvedValue(readyPlan({ displayTarget: "packages/team-tools" }));
    const api = { previewOperation } as unknown as DesktopApi;
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
    act(() => rendered?.container.querySelector<HTMLElement>("[data-testid='import-new-package']")?.click());
    const input = rendered.container.querySelector<HTMLInputElement>("[data-testid='import-new-package-name']");
    act(() => {
      if (input) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Team tools");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    act(() => {
      const description = rendered!.container.querySelector<HTMLInputElement>(
        '[aria-label="Plugin description in English"]',
      );
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        description,
        "Shared tools for the team.",
      );
      description?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(previewOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: {
          newPackageName: "Team tools",
          description: "Shared tools for the team.",
          projectTo: ["claude-code", "codex"],
        },
      }),
    );
    expect(rendered.container.textContent).toContain("review → Team tools");
  });
});
