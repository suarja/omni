// @vitest-environment jsdom

import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssignmentWorkbench } from "../../src/renderer/canvas/changes/AssignmentWorkbench";
import { I18nProvider } from "../../src/renderer/i18n";
import { SettingsSections } from "../../src/renderer/settings/SettingsSections";
import type { CatalogueUnit } from "../../src/renderer/catalogue/catalogue";
import type { DesktopApi } from "../../src/shared/ipc";
import type { Binding } from "../../src/domain/assignment-plan";

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
const projectObservation = {
  subject: project.ref,
  observedAt: "2026-09-13T10:00:00.000Z",
  inventory: {
    rootHandle: "project",
    displayRoot: "acme-web",
    observedAt: "2026-09-13T10:00:00.000Z",
    harnesses: ["codex"],
    artifacts: [],
    diagnostics: [],
    gitScopes: [],
  },
};
const binding: Binding = {
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
const bindingPreview = {
  key: "personal:tools:skills/architect:skill",
  sourceId: "personal",
  packageId: "tools",
  artifactPath: "skills/architect",
  kind: "skill" as const,
  plans: [
    {
      projectId: "project-one",
      planId: "plan-one",
      status: "conflict" as const,
      actions: [
        {
          bindingId: "binding-one",
          harnessId: "codex" as const,
          kind: "skill" as const,
          relativePath: ".agents/skills/architect",
          state: "conflict" as const,
          reason: "Target contains local changes.",
        },
      ],
    },
  ],
};

function createApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    listRegistry: vi.fn(),
    registerProject: vi.fn(),
    registerSource: vi.fn(),
    openEntry: vi.fn(),
    observeProject: vi.fn(),
    observeSource: vi.fn(),
    archiveEntry: vi.fn(),
    reactivateEntry: vi.fn(),
    previewBindings: vi.fn().mockResolvedValue({
      status: "ready",
      units: [{ kind: "skill", id: "architect", artifactPath: "skills/architect", contentHash: "a".repeat(64) }],
      plans: [
        {
          projectId: project.ref.id,
          planId: "plan-one",
          status: "ready",
          actions: [
            {
              bindingId: "binding-one",
              harnessId: "codex",
              kind: "skill",
              relativePath: ".agents/skills/architect",
              state: "add",
            },
          ],
        },
      ],
    }),
    saveBindings: vi.fn().mockResolvedValue({ status: "ready", bindings: [] }),
    previewApply: vi.fn().mockResolvedValue({
      status: "ready",
      planId: "apply-plan-one",
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
    ...overrides,
  };
}

function renderPage(
  api: DesktopApi,
  overrides: Partial<React.ComponentProps<typeof AssignmentWorkbench>> = {},
): { container: HTMLDivElement; root: Root } {
  return render(
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
    />,
  );
}

function AssignmentWithChangingOpenedEntry({ api }: { api: DesktopApi }): React.ReactElement {
  const [openedEntry, setOpenedEntry] = useState<"source" | "project">("source");
  const onEnsureGrant = useCallback<React.ComponentProps<typeof AssignmentWorkbench>["onEnsureGrant"]>(async (ref) => {
    setOpenedEntry(ref.kind);
    return ref.kind === "source" ? "grant-source" : "grant-project";
  }, []);
  return (
    <>
      <output data-testid="opened-entry">{openedEntry}</output>
      <AssignmentWorkbench
        api={api}
        artifactPath="skills/architect"
        packageId="tools"
        packageName="Tools"
        projects={[project]}
        source={source}
        unit={unit}
        onEnsureGrant={onEnsureGrant}
        onNavigate={vi.fn()}
        returnTo={{ screen: "library", tab: "marketplaces" }}
      />
    </>
  );
}

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

describe("Brief 15 assignment page", () => {
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
    vi.useRealTimers();
  });

  it("requests a preview with source and project grants after selecting a project and harness", async () => {
    const api = createApi();
    rendered = renderPage(api);
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-project-project-one']")?.click(),
    );
    act(() => rendered?.container.querySelector<HTMLInputElement>("[data-testid='assignment-harness-codex']")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.previewBindings).toHaveBeenCalledWith({
      source: { id: "personal", grantHandle: "grant-source" },
      packageId: "tools",
      artifactPath: "skills/architect",
      projects: [{ projectId: "project-one", grantHandle: "grant-project", harnessIds: ["codex"] }],
    });
    expect(rendered?.container.textContent).toContain("Add");
  });

  it("keeps the preview when opening a project replaces the currently opened entry", async () => {
    vi.useFakeTimers();
    const api = createApi();
    rendered = render(<AssignmentWithChangingOpenedEntry api={api} />);
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-project-project-one']")?.click(),
    );
    act(() => rendered?.container.querySelector<HTMLInputElement>("[data-testid='assignment-harness-codex']")?.click());
    await act(async () => vi.advanceTimersByTimeAsync(300));

    expect(rendered?.container.querySelector("[data-testid='opened-entry']")?.textContent).toBe("project");
    expect(api.previewBindings).toHaveBeenCalledTimes(1);
    expect(rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-save']")?.disabled).toBe(
      false,
    );
  });

  it("disables save when any selected plan is blocked", async () => {
    const api = createApi({
      previewBindings: vi.fn().mockResolvedValue({
        status: "ready",
        units: [{ kind: "skill", id: "architect", artifactPath: "skills/architect", contentHash: "a".repeat(64) }],
        plans: [
          {
            projectId: "project-one",
            planId: "plan-one",
            status: "blocked",
            actions: [
              {
                bindingId: "binding-one",
                harnessId: "codex",
                kind: "skill",
                relativePath: ".agents/skills/architect",
                state: "blocked",
                reason: "Target is managed by a provider.",
              },
            ],
          },
        ],
      }),
    });
    rendered = renderPage(api);
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-project-project-one']")?.click(),
    );
    act(() => rendered?.container.querySelector<HTMLInputElement>("[data-testid='assignment-harness-codex']")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rendered?.container.querySelector<HTMLButtonElement>("[data-testid='assignment-save']")?.disabled).toBe(
      true,
    );
  });
});
