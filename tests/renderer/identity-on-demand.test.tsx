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

const project = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Omni Project",
  displayRoot: "acme-workspace",
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
const artifact = {
  id: "agents",
  physicalIdentity: "AGENTS.md",
  projectionPaths: ["AGENTS.md"],
  kind: "instruction" as const,
  relativePath: "AGENTS.md",
  displayPath: "AGENTS.md",
  providerIds: ["codex"],
  scope: "project" as const,
  confidence: "exact" as const,
  symlinkState: "none" as const,
};

function observation(subject: EntryRef): Observation {
  return {
    subject,
    observedAt: "2026-09-12T10:00:00.000Z",
    inventory: {
      rootHandle: "opaque-grant",
      displayRoot: subject.id,
      observedAt: "2026-09-12T10:00:00.000Z",
      harnesses: subject.kind === "project" ? ["codex"] : [],
      artifacts: subject.kind === "project" ? [artifact] : [],
      diagnostics: [],
      gitScopes: [],
    },
  };
}

function registryResponse(): RegistryViewResponse {
  return { status: "ready", registry: { revision: 1, projects: [project], sources: [personalSource] } };
}

function apiFor(hashArtifacts: DesktopApi["hashArtifacts"]): DesktopApi {
  return {
    listRegistry: vi.fn().mockResolvedValue(registryResponse()),
    registerProject: vi.fn(),
    registerSource: vi.fn(),
    openEntry: vi.fn().mockImplementation(async (ref: EntryRef) => ({
      status: "granted" as const,
      entry: ref.kind === "project" ? project : personalSource,
      grantHandle: `${ref.kind}-grant`,
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
    hashArtifacts,
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

describe("identity on demand for route observations", () => {
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

  it("hashes a project's observed artifacts after opening it from the registry", async () => {
    const hashArtifacts = vi
      .fn()
      .mockResolvedValue({ status: "hashed", subject: project.ref, identities: [], skipped: [] });
    const api = apiFor(hashArtifacts);
    rendered = renderApp(api);
    await flushEffects();

    click(rendered.container, "canvas-entry-project-project-one");
    await flushEffects();

    expect(hashArtifacts).toHaveBeenCalledWith({
      kind: "project",
      id: "project-one",
      grantHandle: "project-grant",
      artifacts: [{ artifactId: "agents", relativePath: "AGENTS.md", kind: "instruction" }],
    });
  });

  it("hashes the personal source opened from Library and stays usable when hashing fails", async () => {
    const hashArtifacts = vi.fn().mockRejectedValue(new Error("hashing backend unavailable"));
    const api = apiFor(hashArtifacts);
    rendered = renderApp(api);
    await flushEffects();

    await flushEffects();
    click(rendered.container, "canvas-entry-source-personal-source");
    await flushEffects();

    expect(hashArtifacts).toHaveBeenCalledWith({
      kind: "source",
      id: "personal-source",
      grantHandle: "source-grant",
      artifacts: [],
    });
    // The hashing failure is non-fatal: the Library destination still renders normally.
    expect(rendered.container.querySelector("[data-testid='resource-canvas']")).toBeTruthy();
  });
});
