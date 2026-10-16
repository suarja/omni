// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { I18nProvider } from "../../src/renderer/i18n";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import type { EntryRef, Observation } from "../../src/domain/project-source-registry";
import type { DesktopApi } from "../../src/shared/ipc";
import type { RegistryViewResponse } from "../../src/shared/registry-ipc";

declare global {
  interface Window {
    omni?: DesktopApi;
  }
}

const projectOne = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Omni Project",
  displayRoot: "acme-workspace",
  availability: "available" as const,
};
const projectTwo = {
  ref: { kind: "project" as const, id: "project-two" },
  displayName: "Docs Project",
  displayRoot: "DocsProject",
  availability: "available" as const,
};
const personalSource = {
  ref: { kind: "source" as const, id: "personal-source" },
  displayName: "Personal Skills",
  displayRoot: "personal-skills",
  availability: "available" as const,
  ownership: "personal" as const,
  capabilities: { observe: true as const, write: false as const },
};
const externalSource = {
  ref: { kind: "source" as const, id: "external-source" },
  displayName: "Cursor Plugins",
  displayRoot: "cursor-plugins",
  availability: "available" as const,
  ownership: "external" as const,
  capabilities: { observe: true as const, write: false as const },
};

const allEntries = [projectOne, projectTwo, personalSource, externalSource];

function entryFor(ref: EntryRef): (typeof allEntries)[number] {
  const match = allEntries.find((entry) => entry.ref.kind === ref.kind && entry.ref.id === ref.id);
  if (!match) throw new Error(`No fixture entry for ${ref.kind}:${ref.id}.`);
  return match;
}

function observation(subject: EntryRef): Observation {
  return {
    subject,
    observedAt: "2026-09-12T10:00:00.000Z",
    inventory: {
      rootHandle: "opaque-grant",
      displayRoot: subject.id,
      observedAt: "2026-09-12T10:00:00.000Z",
      harnesses: subject.kind === "project" ? ["codex"] : [],
      artifacts: [],
      diagnostics: [],
      gitScopes: [],
    },
  };
}

function registryResponse(): RegistryViewResponse {
  return {
    status: "ready",
    registry: { revision: 1, projects: [projectOne, projectTwo], sources: [personalSource, externalSource] },
  };
}

function apiFor(): DesktopApi {
  return {
    listRegistry: vi.fn().mockResolvedValue(registryResponse()),
    registerProject: vi.fn(),
    registerSource: vi.fn(),
    openEntry: vi.fn().mockImplementation(async (ref: EntryRef) => ({
      status: "granted" as const,
      entry: entryFor(ref),
      grantHandle: `${ref.kind}-${ref.id}-grant`,
    })),
    observeProject: vi.fn().mockImplementation(async ({ projectId }: { projectId: string }) => ({
      status: "observed" as const,
      observation: observation({ kind: "project", id: projectId }),
    })),
    observeSource: vi.fn().mockImplementation(async ({ sourceId }: { sourceId: string }) => ({
      status: "observed" as const,
      observation: observation({ kind: "source", id: sourceId }),
    })),
    archiveEntry: vi.fn(),
    reactivateEntry: vi.fn(),
    hashArtifacts: vi.fn().mockResolvedValue({
      status: "hashed",
      subject: { kind: "project", id: "project-one" },
      identities: [],
      skipped: [],
    }),
  };
}

type Rendered = Readonly<{ container: HTMLDivElement; root: Root }>;

function renderApp(api: DesktopApi): Rendered {
  const container = document.createElement("div");
  const root = createRoot(container);
  window.omni = api;
  document.body.append(container);
  act(() => {
    root.render(
      <ThemeProvider>
        <I18nProvider initialLanguage="en">
          <App />
        </I18nProvider>
      </ThemeProvider>,
    );
  });
  return { container, root };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(container: HTMLDivElement, testId: string): void {
  act(() => {
    container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
  });
}

describe("audit start race", () => {
  let rendered: Rendered | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    delete window.omni;
    vi.restoreAllMocks();
  });

  it("audits all active roots from Review findings without first-launch state", async () => {
    const api = apiFor();
    rendered = renderApp(api);
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>(".canvas-rail-button[aria-label='Review']")?.click(),
    );
    expect(rendered.container.querySelector("[data-testid='canvas-review-sheet']")).toBeTruthy();
    click(rendered.container, "canvas-run-audit");
    for (let attempt = 0; attempt < 8; attempt += 1) await flushEffects();
    expect(api.openEntry).toHaveBeenCalledTimes(4);
    expect(api.observeProject).toHaveBeenCalledTimes(2);
    expect(api.observeSource).toHaveBeenCalledTimes(2);
    expect(rendered.container.textContent).not.toContain("Start the audit");
    expect(rendered.container.querySelector("[data-testid='onboarding-step-audit']")).toBeNull();
  });

  it("includes a newly registered root when the next audit starts", async () => {
    const api = apiFor();
    vi.mocked(api.listRegistry).mockResolvedValueOnce({
      status: "ready",
      registry: { revision: 1, projects: [projectOne], sources: [] },
    });
    rendered = renderApp(api);
    await flushEffects();
    act(() => rendered?.container.querySelector<HTMLButtonElement>("[aria-label='Refresh']")?.click());
    await flushEffects();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>(".canvas-rail-button[aria-label='Review']")?.click(),
    );
    click(rendered.container, "canvas-run-audit");
    for (let attempt = 0; attempt < 8; attempt += 1) await flushEffects();
    expect(api.openEntry).toHaveBeenCalledTimes(4);
  });
});
