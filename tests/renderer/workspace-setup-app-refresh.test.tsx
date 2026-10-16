// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { I18nProvider } from "../../src/renderer/i18n";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import type { DesktopApi } from "../../src/shared/ipc";
import type { OperationPlan, OperationReceipt } from "../../src/shared/operations-ipc";

declare global {
  interface Window {
    omni?: DesktopApi;
  }
}

const project = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Workspace project",
  displayRoot: "workspace",
  availability: "available" as const,
};
const createdSource = {
  ref: { kind: "source" as const, id: "source-created" },
  displayName: "personal-skills",
  displayRoot: "personal-skills",
  availability: "available" as const,
  ownership: "personal" as const,
  capabilities: { observe: true as const, write: false as const },
};
const externalSource = {
  ref: { kind: "source" as const, id: "source-external" },
  displayName: "external-marketplace",
  displayRoot: "external-marketplace",
  availability: "available" as const,
  ownership: "external" as const,
  capabilities: { observe: true as const, write: false as const },
};
const initialRegistry = { revision: 1, projects: [project], sources: [] };
const updatedRegistry = { revision: 2, projects: [project], sources: [createdSource] };
const completeRegistry = { revision: 3, projects: [project], sources: [createdSource, externalSource] };

function projectObservation() {
  return {
    status: "observed" as const,
    observation: {
      subject: project.ref,
      observedAt: "2026-10-04T12:00:00.000Z",
      inventory: {
        rootHandle: "project-grant",
        displayRoot: "workspace",
        observedAt: "2026-10-04T12:00:00.000Z",
        harnesses: ["codex"],
        artifacts: [
          {
            id: "local-context",
            physicalIdentity: ".claude/skills/local-context/SKILL.md",
            projectionPaths: [".claude/skills/local-context/SKILL.md"],
            kind: "skill" as const,
            relativePath: ".claude/skills/local-context/SKILL.md",
            displayPath: ".claude/skills/local-context/SKILL.md",
            providerIds: ["claude-code"],
            scope: "project" as const,
            confidence: "exact" as const,
            symlinkState: "none" as const,
          },
        ],
        diagnostics: [],
        gitScopes: [],
      },
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(container: HTMLDivElement, selector: string): void {
  act(() => container.querySelector<HTMLButtonElement>(selector)?.click());
}

describe("workspace setup app refresh", () => {
  let rendered: Readonly<{ container: HTMLDivElement; root: Root }> | undefined;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.replaceChildren();
    document.documentElement.dataset.theme = "light";
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    delete window.omni;
    vi.restoreAllMocks();
  });

  it("keeps previously observed project resources after creating a marketplace", async () => {
    const plan: OperationPlan = {
      planId: "marketplace-plan",
      kind: "create-marketplace",
      displayTarget: "personal-skills",
      actions: [{ kind: "create-directory", relativePath: "." }],
      git: { mode: "disabled", warnings: [] },
    };
    const receipt: OperationReceipt = {
      operationId: "marketplace-operation",
      kind: "create-marketplace",
      status: "applied",
      appliedAt: "2026-10-04T12:00:00.000Z",
      displayTarget: "personal-skills",
      actions: [],
      git: { mode: "disabled" },
      registered: { sourceId: "source-created" },
    };
    const api = {
      listRegistry: vi
        .fn()
        .mockResolvedValueOnce({ status: "ready", registry: initialRegistry })
        .mockResolvedValueOnce({ status: "ready", registry: updatedRegistry })
        .mockResolvedValue({ status: "ready", registry: completeRegistry }),
      registerProject: vi.fn(),
      registerSource: vi.fn().mockResolvedValue({
        status: "ready",
        outcome: "created",
        entry: externalSource,
        grantHandle: "source-grant",
        registryRevision: 3,
      }),
      openEntry: vi.fn().mockImplementation(async (ref: { kind: "project" | "source" }) => ({
        status: "granted",
        entry: ref.kind === "project" ? project : externalSource,
        grantHandle: ref.kind === "project" ? "project-grant" : "source-grant",
      })),
      observeProject: vi.fn().mockResolvedValue(projectObservation()),
      observeSource: vi.fn().mockResolvedValue({
        ...projectObservation(),
        observation: {
          ...projectObservation().observation,
          subject: externalSource.ref,
          inventory: {
            ...projectObservation().observation.inventory,
            rootHandle: "source-grant",
            displayRoot: "external-marketplace",
            artifacts: [],
          },
        },
      }),
      archiveEntry: vi.fn(),
      reactivateEntry: vi.fn(),
      pickOperationParent: vi
        .fn()
        .mockResolvedValue({ status: "picked", parentToken: "parent", displayParent: "Workspace" }),
      previewOperation: vi.fn().mockResolvedValue({ status: "ready", plan }),
      applyOperation: vi.fn().mockResolvedValue({ status: "applied", receipt }),
    } as unknown as DesktopApi;
    const container = document.createElement("div");
    const root = createRoot(container);
    rendered = { container, root };
    window.omni = api;
    document.body.append(container);
    act(() =>
      root.render(
        <ThemeProvider>
          <I18nProvider initialLanguage="en">
            <App />
          </I18nProvider>
        </ThemeProvider>,
      ),
    );
    await flush();

    click(container, "[data-testid='onboarding-skip']");
    click(container, ".canvas-node[data-kind='project']");
    await flush();
    expect(container.textContent).toContain("Individual skills");
    click(container, "button[data-group-id='individual-skills']");
    await flush();
    expect(container.textContent).toContain("local-context");
    act(() => container.querySelector<HTMLButtonElement>(".canvas-breadcrumbs button:first-child")?.click());
    expect(container.querySelector("[data-testid='canvas-setup-menu-trigger']")).not.toBeNull();
    click(container, "[data-testid='canvas-setup-menu-trigger']");
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-add-marketplace']")?.click());
    expect(container.querySelector("[data-testid='canvas-setup-sheet']")).not.toBeNull();
    click(container, "[data-testid='canvas-setup-choice-existing']");
    click(container, "[data-testid='canvas-setup-choice-create']");
    expect(container.querySelector("[data-testid='canvas-setup-create-form']")).not.toBeNull();
    click(container, "[data-testid='canvas-setup-marketplace-pick-parent']");
    await flush();
    click(container, "[data-testid='canvas-setup-marketplace-preview']");
    await flush();
    click(container, "[data-testid='canvas-setup-marketplace-apply']");
    await flush();

    if (container.querySelector("[data-testid='canvas-setup-refresh-registry']")) {
      click(container, "[data-testid='canvas-setup-refresh-registry']");
      await flush();
    }
    click(container, "[aria-label='Close setup']");
    click(container, "[data-testid='canvas-setup-menu-trigger']");
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-add-marketplace']")?.click());
    click(container, "[data-testid='canvas-setup-choice-external']");
    click(container, "[data-testid='canvas-setup-connect-source']");
    await flush();
    expect(api.registerSource).toHaveBeenCalledWith({ ownership: "external" });
    expect(container.querySelector("[data-testid='canvas-setup-observed-summary']")).not.toBeNull();
    expect(api.listRegistry).toHaveBeenCalledTimes(3);
    act(() =>
      container.querySelector<HTMLButtonElement>("[data-testid='canvas-setup-sheet'] button:last-child")?.click(),
    );
    click(container, ".canvas-search-trigger");
    const search = container.querySelector<HTMLInputElement>(".canvas-search-input input");
    if (!search) throw new Error("Workspace search input was not rendered.");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(search, "local-context");
    act(() => search.dispatchEvent(new Event("input", { bubbles: true })));
    expect(container.textContent).toContain("local-context");
    expect(container.textContent).not.toContain("No matching resources");
  });
});
