// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApplyWorkbench } from "../../src/renderer/canvas/changes/ApplyWorkbench";
import { I18nProvider } from "../../src/renderer/i18n";
import { RemoveWorkbench } from "../../src/renderer/canvas/changes/RemoveWorkbench";
import { RestoreWorkbench } from "../../src/renderer/canvas/changes/RestoreWorkbench";
import { SettingsSections } from "../../src/renderer/settings/SettingsSections";
import { rootDestination } from "../../src/renderer/navigation";
import type { Binding } from "../../src/domain/assignment-plan";
import type { DesktopApi } from "../../src/shared/ipc";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES } from "../../src/shared/settings-ipc";

const source = {
  ref: { kind: "source" as const, id: "marketplace" },
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
const binding: Binding = {
  bindingId: "binding-one",
  sourceId: "marketplace",
  packageId: "tools",
  artifactPath: "skills/architect",
  kind: "skill",
  projectId: "project-one",
  harnessId: "codex",
  boundHash: "a".repeat(64),
  createdAt: "2026-09-13T10:00:00.000Z",
};
const audit = { status: "completed" as const, report: { observations: [], findings: [], unavailable: [] } };
const receipt = {
  operationId: "operation-one",
  kind: "apply-plan" as const,
  status: "applied" as const,
  appliedAt: "2026-09-13T10:00:00.000Z",
  displayTarget: "Acme Web",
  units: ["architect"],
  actions: [
    { kind: "write-file" as const, relativePath: ".agents/skills/architect/SKILL.md", status: "applied" as const },
  ],
  git: { mode: "commit" as const, commit: "abcdef1234567" },
  registered: null,
  project: { id: "project-one" },
  files: [
    { relativePath: ".agents/skills/architect/SKILL.md", contentHash: "b".repeat(64), previousHash: "a".repeat(64) },
  ],
};

function render(element: React.ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(<I18nProvider>{element}</I18nProvider>));
  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function api(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    previewApply: vi.fn().mockResolvedValue({
      status: "ready",
      planId: "plan-apply",
      project: { displayName: "Acme Web" },
      actions: [
        {
          actionId: "action-conflict",
          bindingId: "binding-one",
          harnessId: "codex",
          kind: "skill",
          relativePath: ".agents/skills/architect",
          state: "conflict",
          reason: "Target contains local changes.",
          needsResolution: true,
          diff: { kind: "unified", text: "@@\n-old\n+new", truncated: false },
        },
        {
          actionId: "action-add",
          bindingId: "binding-two",
          harnessId: "claude-code",
          kind: "skill",
          relativePath: ".claude/skills/architect",
          state: "add",
          needsResolution: false,
        },
      ],
      git: { mode: "commit" },
    }),
    runApply: vi.fn().mockResolvedValue({ status: "applied", receipt }),
    previewRemove: vi.fn().mockResolvedValue({
      status: "ready",
      planId: "plan-remove",
      project: { displayName: "Acme Web" },
      unit: { id: "architect", harnessId: "codex" },
      files: [
        {
          relativePath: ".agents/skills/architect/SKILL.md",
          modified: true,
          diff: { kind: "unified", text: "@@\n-old\n+new", truncated: false },
        },
      ],
      git: { mode: "not-a-repository" },
    }),
    runRemove: vi.fn().mockResolvedValue({
      status: "applied",
      receipt: {
        ...receipt,
        kind: "remove-binding",
        displayTarget: "architect",
        files: [{ relativePath: ".agents/skills/architect/SKILL.md", contentHash: "a".repeat(64) }],
      },
    }),
    listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [receipt] }),
    previewRestoreApply: vi.fn().mockResolvedValue({
      status: "ready",
      planId: "plan-restore",
      project: { id: "project-one" },
      files: [{ relativePath: ".agents/skills/architect/SKILL.md", action: "restore" }],
    }),
    runRestoreApply: vi.fn().mockResolvedValue({ status: "applied", receipt: { ...receipt, kind: "restore-apply" } }),
    getSettings: vi.fn().mockResolvedValue({ schemaVersion: 1, git: { commitChanges: true } }),
    setSettings: vi.fn().mockResolvedValue({ schemaVersion: 1, git: { commitChanges: false } }),
    ...overrides,
  } as unknown as DesktopApi;
}

describe("Brief 18 renderer lifecycle", () => {
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

  it("maps lifecycle routes to their shell destinations", () => {
    expect(rootDestination({ screen: "operation-apply", projectId: "project-one" })).toBe("review");
    expect(rootDestination({ screen: "operation-remove", bindingId: "binding-one", projectId: "project-one" })).toBe(
      "projects",
    );
    expect(rootDestination({ screen: "operation-restore-apply", operationId: "operation-one" })).toBe("review");
  });

  it("previews apply with both grants and requires a conflict choice before applying", async () => {
    const desktop = api();
    const onEnsureGrant = vi
      .fn()
      .mockImplementation(async (ref: { kind: string; id: string }) => `${ref.kind}-${ref.id}-grant`);
    rendered = render(
      <ApplyWorkbench
        api={desktop}
        project={project}
        sourceId={source.ref.id}
        onEnsureGrant={onEnsureGrant}
        onNavigateToRoute={vi.fn()}
        onProjectChanged={vi.fn()}
      />,
    );
    await flush();

    expect(desktop.previewApply).toHaveBeenCalledWith({
      projectId: "project-one",
      grantHandle: "project-project-one-grant",
      sourceGrantHandle: "source-marketplace-grant",
    });
    expect(rendered.container.textContent).toContain("What will change");
    expect(rendered.container.querySelector<HTMLButtonElement>("[data-testid='apply-run']")?.disabled).toBe(true);

    act(() =>
      rendered?.container
        .querySelector<HTMLButtonElement>("[data-testid='apply-choice-action-conflict-take-marketplace']")
        ?.click(),
    );
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='apply-diff-action-conflict']")?.click(),
    );
    expect(rendered.container.textContent).toContain("+new");
    act(() => rendered?.container.querySelector<HTMLButtonElement>("#changes-tab-targets")?.click());
    expect(rendered.container.querySelector('[data-testid="apply-effects"]')?.closest("[hidden]")).toBeNull();
    expect(rendered.container.querySelector('[data-testid="apply-effects"]')?.textContent).toContain(
      ".agents/skills/architect",
    );
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='apply-run']")?.click());
    await flush();

    expect(desktop.runApply).toHaveBeenCalledWith({
      planId: "plan-apply",
      resolutions: [{ actionId: "action-conflict", choice: "take-marketplace" }],
    });
    expect(rendered.container.textContent).toContain("file written");
    expect(rendered.container.textContent).not.toContain("kept");
  });

  it("shows a blocked preview diagnostic and lets the user preview again", async () => {
    const onNavigateToRoute = vi.fn();
    rendered = render(
      <ApplyWorkbench
        api={api({
          previewApply: vi.fn().mockResolvedValue({
            status: "blocked",
            reason: "plan-changed",
            diagnostic: "The project changed; preview it again.",
          }),
        })}
        project={project}
        sourceId={source.ref.id}
        onEnsureGrant={vi.fn().mockResolvedValue("grant")}
        onNavigateToRoute={onNavigateToRoute}
        onProjectChanged={vi.fn()}
      />,
    );
    await flush();
    expect(rendered.container.textContent).toContain("The project changed; preview it again.");
    const previewAgain = rendered.container.querySelector<HTMLButtonElement>("[data-testid='apply-preview-again']");
    act(() => previewAgain?.click());
    await flush();
    expect(onNavigateToRoute).not.toHaveBeenCalled();
  });

  it("previews and runs removal with modified file details", async () => {
    const desktop = api();
    rendered = render(
      <RemoveWorkbench
        api={desktop}
        bindingId="binding-one"
        projectId="project-one"
        projectName="Acme Web"
        unitName="architect"
        onEnsureGrant={vi.fn().mockResolvedValue("grant-project")}
        onNavigateToRoute={vi.fn()}
        onProjectChanged={vi.fn()}
      />,
    );
    await flush();
    expect(desktop.previewRemove).toHaveBeenCalledWith({ bindingId: "binding-one", grantHandle: "grant-project" });
    expect(rendered.container.textContent).toContain("modified");
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='remove-diff-0']")?.click());
    expect(rendered.container.textContent).toContain("+new");
    act(() => rendered?.container.querySelector<HTMLButtonElement>("#changes-tab-targets")?.click());
    expect(rendered.container.querySelector('[data-testid="remove-effects"]')?.closest("[hidden]")).toBeNull();
    expect(rendered.container.querySelector('[data-testid="remove-effects"]')?.textContent).toContain(
      ".agents/skills/architect/SKILL.md",
    );
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='remove-run']")?.click());
    await flush();
    expect(desktop.runRemove).toHaveBeenCalledWith({ planId: "plan-remove" });
    expect(rendered.container.textContent).toContain("file removed");
  });

  it("restores apply and remove receipts through the generalized lifecycle API", async () => {
    const desktop = api();
    rendered = render(
      <RestoreWorkbench
        api={desktop}
        operationId="operation-one"
        onProjectChanged={vi.fn()}
        onMarketplaceChanged={vi.fn()}
        onNavigateToRoute={vi.fn()}
      />,
    );
    await flush();
    expect(desktop.previewRestoreApply).toHaveBeenCalledWith({ operationId: "operation-one" });
    expect(rendered.container.textContent).toContain("Restore Acme Web");
    expect(rendered.container.textContent).toContain("before the apply");
    expect(rendered.container.textContent).toContain("(architect)");
    expect(rendered.container.textContent).toContain("One commit in Acme Web");
    act(() => rendered?.container.querySelector<HTMLButtonElement>("#changes-tab-targets")?.click());
    expect(rendered?.container.querySelector("[data-testid='restore-apply']")?.closest("[hidden]")).toBeNull();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='restore-apply']")?.click());
    await flush();
    expect(desktop.runRestoreApply).toHaveBeenCalledWith({ planId: "plan-restore" });
    expect(rendered.container.textContent).toContain("Restored");
  });

  it("shows a failed removal diagnostic without claiming files were removed", async () => {
    const onProjectChanged = vi.fn();
    const desktop = api({
      runRemove: vi.fn().mockResolvedValue({
        status: "failed",
        receipt: {
          ...receipt,
          kind: "remove-binding",
          status: "failed",
          diagnostic: "The target changed; preview again.",
        },
      }),
    });
    rendered = render(
      <RemoveWorkbench
        api={desktop}
        bindingId="binding-one"
        projectId="project-one"
        projectName="Acme Web"
        unitName="architect"
        onEnsureGrant={vi.fn().mockResolvedValue("grant-project")}
        onNavigateToRoute={vi.fn()}
        onProjectChanged={onProjectChanged}
      />,
    );
    await flush();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[data-testid='remove-run']")?.click());
    await flush();
    expect(rendered.container.textContent).toContain("The target changed; preview again.");
    expect(rendered.container.textContent).not.toContain("file removed");
    expect(onProjectChanged).not.toHaveBeenCalled();
  });

  it("describes a removed binding by project and unit instead of operation id", async () => {
    const removedReceipt = { ...receipt, kind: "remove-binding" as const };
    const desktop = api({ listOperations: vi.fn().mockResolvedValue({ status: "ready", receipts: [removedReceipt] }) });
    rendered = render(
      <RestoreWorkbench
        api={desktop}
        operationId="operation-one"
        onProjectChanged={vi.fn()}
        onNavigateToRoute={vi.fn()}
      />,
    );
    await flush();

    expect(rendered.container.textContent).toContain("Puts back architect removed on");
    expect(rendered.container.textContent).toContain("Restore Acme Web");
  });
});
