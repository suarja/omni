// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ObservedPackage } from "../../src/domain/inventory";
import type { Observation, SourceEntryView } from "../../src/domain/project-source-registry";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationPlan, OperationReceipt } from "../../src/shared/operations-ipc";
import { I18nProvider, t } from "../../src/renderer/i18n";
import { CompatibilityWorkbench } from "../../src/renderer/canvas/changes/CompatibilityWorkbench";
import { FeaturesProvider } from "../../src/renderer/features";
import { DEFAULT_FEATURES } from "../../src/shared/settings-ipc";

const source: SourceEntryView = {
  ref: { kind: "source", id: "source-one" },
  displayName: "Owner marketplace",
  displayRoot: "owner-marketplace",
  availability: "available",
  ownership: "personal",
  capabilities: { observe: true, write: false },
};

const packages: ObservedPackage[] = [
  {
    id: "pstack",
    relativeRoot: "packages/pstack",
    displayName: "pstack",
    format: "omni",
    manifestPaths: [
      "packages/pstack/omni.plugin.json",
      "packages/pstack/.claude-plugin/plugin.json",
      "packages/pstack/.codex-plugin/plugin.json",
    ],
    artifactIds: [],
  },
];

const observation: Observation = {
  subject: source.ref,
  observedAt: "2026-09-14T10:00:00.000Z",
  inventory: {
    rootHandle: "source-grant",
    displayRoot: source.displayRoot,
    observedAt: "2026-09-14T10:00:00.000Z",
    harnesses: [],
    artifacts: [],
    packages,
    marketplace: { name: source.displayName, manifestPath: "omni.marketplace.json" },
    diagnostics: [],
    gitScopes: [],
  },
};

const report = {
  harness: "codex" as const,
  packages: [
    {
      packageId: "pstack",
      name: "pstack",
      path: "packages/pstack",
      verdict: "ready" as const,
      artifacts: Array.from({ length: 12 }, (_, index) => ({
        path: `skills/skill-${index}/SKILL.md`,
        kind: "skill" as const,
        status: "transposable" as const,
        reason: "The same skill folder is discovered by both harnesses.",
      })),
    },
    {
      packageId: "codebase-wiki",
      name: "codebase-wiki",
      path: "packages/codebase-wiki",
      verdict: "partial" as const,
      reason: "Codex cannot project command files.",
      artifacts: [
        {
          path: "commands/check.md",
          kind: "command" as const,
          status: "not-transposable" as const,
          reason: "Codex cannot project commands that use $ARGUMENTS.",
        },
      ],
    },
    {
      packageId: "remote-tools",
      name: "remote-tools",
      path: "remote-tools",
      verdict: "remote" as const,
      artifacts: [],
    },
  ],
};

function plan(overrides: Partial<OperationPlan> = {}): OperationPlan {
  return {
    planId: "plan-compatible",
    kind: "make-compatible",
    displayTarget: "Owner marketplace",
    actions: [
      { kind: "create-directory", relativePath: ".agents/plugins" },
      { kind: "write-file", relativePath: ".agents/plugins/marketplace.json", byteLength: 120, manifest: true },
      {
        kind: "write-file",
        relativePath: "packages/pstack/.codex-plugin/plugin.json",
        byteLength: 240,
        manifest: true,
      },
      { kind: "write-file", relativePath: "omni.marketplace.json", byteLength: 180, manifest: true },
      { kind: "write-file", relativePath: "packages/pstack/omni.plugin.json", byteLength: 160, manifest: true },
      {
        kind: "write-file",
        relativePath: ".agents/plugins/marketplace.json",
        byteLength: 330,
        manifest: true,
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    ],
    git: { mode: "commit", warnings: [] },
    report,
    ...overrides,
  };
}

function receipt(status: "applied" | "failed" = "applied"): OperationReceipt {
  return {
    operationId: "operation-compatible",
    kind: "make-compatible",
    status,
    appliedAt: "2026-09-14T10:00:00.000Z",
    displayTarget: "Owner marketplace",
    harness: "codex",
    actions: [
      {
        kind: "write-file",
        relativePath: "omni.marketplace.json",
        status: status === "applied" ? "applied" : "rolled-back",
      },
    ],
    git: { mode: "commit", commit: status === "applied" ? "abcdef1234567" : undefined },
    registered: null,
    diagnostic: status === "failed" ? "The approved manifest changed." : undefined,
  };
}

const learnFeatures = { features: { ...DEFAULT_FEATURES, learn: true }, setFeatures: () => undefined };

function render(element: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() =>
    root.render(
      <I18nProvider initialLanguage="en">
        <FeaturesProvider value={learnFeatures}>{element}</FeaturesProvider>
      </I18nProvider>,
    ),
  );
  return { container, root };
}

async function settlePreview(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("compatibility page", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recomputes a pending request and applies only the updated displayed change", async () => {
    const original = plan();
    const updated = plan({
      planId: "updated-plan",
      actions: [
        ...original.actions,
        { kind: "write-file", relativePath: "new-file.md", afterHash: "a".repeat(64), diff: "+updated" },
      ],
    });
    const pending = {
      requestId: "request-one",
      createdAt: "2026-10-11T00:00:00Z",
      approval: "omni",
      status: "pending",
      request: { kind: "make-compatible", sourceId: source.ref.id, harness: "codex" },
      plan: original,
    };
    const refreshAgentRequest = vi.fn(async () => ({ ...pending, plan: updated }));
    const applyOperation = vi.fn(async () => ({ status: "applied", receipt: receipt() }));
    const resolveAgentRequest = vi.fn(async () => pending);
    const api = {
      listAgentRequests: vi.fn(async () => ({ requests: [pending] })),
      refreshAgentRequest,
      applyOperation,
      resolveAgentRequest,
    } as unknown as DesktopApi;
    rendered = render(
      <CompatibilityWorkbench
        api={api}
        requestId="request-one"
        source={source}
        observation={observation}
        harness="codex"
        sourceGrantHandle="source-grant"
        onMarketplaceChanged={vi.fn()}
        onNavigateToRoute={vi.fn()}
        returnTo={{ screen: "review" }}
      />,
    );
    await settlePreview();
    expect(refreshAgentRequest).toHaveBeenCalledWith("request-one");
    expect(rendered.container.textContent).toContain("Files changed since the agent asked");
    expect(rendered.container.textContent).toContain("new-file.md");
    await act(async () =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='compatibility-apply']")?.click(),
    );
    expect(applyOperation).toHaveBeenCalledWith({ planId: "updated-plan" });
    expect(resolveAgentRequest).toHaveBeenCalledWith({ requestId: "request-one", operationId: "operation-compatible" });
  });

  it("keeps approval and decline disabled until an agent change finishes applying", async () => {
    const pending = {
      requestId: "request-one",
      createdAt: "2026-10-11T00:00:00Z",
      approval: "omni",
      status: "pending",
      request: { kind: "make-compatible", sourceId: source.ref.id, harness: "codex" },
      plan: plan(),
    };
    let finish: (() => void) | undefined;
    const applyOperation = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: "applied", receipt: receipt() });
        }),
    );
    const api = {
      listAgentRequests: vi.fn(async () => ({ requests: [pending] })),
      refreshAgentRequest: vi.fn(async () => pending),
      applyOperation,
      resolveAgentRequest: vi.fn(),
    } as unknown as DesktopApi;
    rendered = render(
      <CompatibilityWorkbench
        api={api}
        requestId="request-one"
        source={source}
        observation={observation}
        harness="codex"
        sourceGrantHandle="source-grant"
        onMarketplaceChanged={vi.fn()}
        onNavigateToRoute={vi.fn()}
        returnTo={{ screen: "review" }}
      />,
    );
    await settlePreview();
    await act(async () =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='compatibility-apply']")?.click(),
    );
    expect(applyOperation).toHaveBeenCalledOnce();
    expect(rendered.container.querySelector<HTMLButtonElement>("[data-testid='compatibility-apply']")?.disabled).toBe(
      true,
    );
    expect(rendered.container.querySelector<HTMLButtonElement>("[data-testid='agent-request-decline']")?.disabled).toBe(
      true,
    );
    await act(async () => finish?.());
  });

  it("renders the report, update choice, diff, and grouped Omni records", async () => {
    const previewOperation = vi.fn().mockResolvedValue({ status: "ready", plan: plan() });
    rendered = render(
      <CompatibilityWorkbench
        api={{ previewOperation } as unknown as DesktopApi}
        harness="codex"
        observation={observation}
        onMarketplaceChanged={vi.fn()}
        onNavigateToRoute={vi.fn()}
        packageId={undefined}
        returnTo={{ screen: "marketplace", sourceId: source.ref.id }}
        source={source}
        sourceGrantHandle="source-grant"
      />,
    );
    await settlePreview();
    expect(previewOperation).toHaveBeenCalledWith({
      kind: "make-compatible",
      sourceId: source.ref.id,
      harness: "codex",
    });
    expect(rendered.container.textContent).toContain("ready · 12 assets");
    expect(rendered.container.textContent).toContain("1 asset stays Claude Code only");
    expect(rendered.container.textContent).toContain("declared remotely · entry copied");
    expect(rendered.container.textContent).toContain("Omni records its manifests (2 files)");
    expect(rendered.container.querySelector(".ui-card")).toBeNull();
    expect(rendered.container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(
      rendered.container
        .querySelector<HTMLButtonElement>("[data-testid='compatibility-update-keep-0']")
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(rendered.container.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='compatibility-diff-0']")?.click());
    expect(rendered.container.textContent).toContain("@@ -1 +1 @@");
  });

  it("re-previews with the chosen marketplace path after a segmented choice", async () => {
    const previewOperation = vi.fn().mockResolvedValue({ status: "ready", plan: plan() });
    rendered = render(
      <CompatibilityWorkbench
        api={{ previewOperation } as unknown as DesktopApi}
        harness="codex"
        observation={observation}
        onMarketplaceChanged={vi.fn()}
        onNavigateToRoute={vi.fn()}
        returnTo={{ screen: "marketplace", sourceId: source.ref.id }}
        source={source}
        sourceGrantHandle="source-grant"
      />,
    );
    await settlePreview();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='compatibility-update-keep-0']")?.click(),
    );
    expect(previewOperation).toHaveBeenCalledTimes(1);
    await settlePreview();
    expect(previewOperation).toHaveBeenLastCalledWith({
      kind: "make-compatible",
      sourceId: source.ref.id,
      harness: "codex",
      keepUpdates: [".agents/plugins/marketplace.json"],
    });
  });

  it("disables the action and explains a zero-action plan", async () => {
    const previewOperation = vi.fn().mockResolvedValue({ status: "ready", plan: plan({ actions: [] }) });
    rendered = render(
      <CompatibilityWorkbench
        api={{ previewOperation } as unknown as DesktopApi}
        harness="codex"
        observation={observation}
        onMarketplaceChanged={vi.fn()}
        onNavigateToRoute={vi.fn()}
        returnTo={{ screen: "marketplace", sourceId: source.ref.id }}
        source={source}
        sourceGrantHandle="source-grant"
      />,
    );
    await settlePreview();
    expect(rendered.container.textContent).toContain("Nothing to write: already compatible with Codex");
    expect(rendered.container.querySelector<HTMLButtonElement>("[data-testid='compatibility-apply']")?.disabled).toBe(
      true,
    );
  });

  it("shows honest applied and failed receipt results", async () => {
    const onMarketplaceChanged = vi.fn();
    const applyOperation = vi.fn().mockResolvedValue({ status: "applied", receipt: receipt() });
    rendered = render(
      <CompatibilityWorkbench
        api={
          {
            applyOperation,
            previewOperation: vi.fn().mockResolvedValue({ status: "ready", plan: plan() }),
          } as unknown as DesktopApi
        }
        harness="codex"
        observation={observation}
        onMarketplaceChanged={onMarketplaceChanged}
        onNavigateToRoute={vi.fn()}
        returnTo={{ screen: "marketplace", sourceId: source.ref.id }}
        source={source}
        sourceGrantHandle="source-grant"
      />,
    );
    await settlePreview();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='compatibility-apply']")?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onMarketplaceChanged).toHaveBeenCalledOnce();
    expect(rendered.container.querySelector("[data-testid='compatibility-result']")?.textContent).toContain("written");
    expect(rendered.container.textContent).toContain("Open the marketplace");
    expect(rendered.container.querySelector(".ui-card")).toBeNull();

    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    const failedApply = vi.fn().mockResolvedValue({ status: "failed", receipt: receipt("failed") });
    rendered = render(
      <CompatibilityWorkbench
        api={
          {
            applyOperation: failedApply,
            previewOperation: vi.fn().mockResolvedValue({ status: "ready", plan: plan() }),
          } as unknown as DesktopApi
        }
        harness="codex"
        observation={observation}
        onMarketplaceChanged={vi.fn()}
        onNavigateToRoute={vi.fn()}
        returnTo={{ screen: "marketplace", sourceId: source.ref.id }}
        source={source}
        sourceGrantHandle="source-grant"
      />,
    );
    await settlePreview();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='compatibility-apply']")?.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toContain("Compatibility failed");
    expect(rendered.container.textContent).toContain("The approved manifest changed.");
    expect(rendered.container.textContent).not.toContain("files written ·");
  });
});
