// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { I18nProvider } from "../../src/renderer/i18n";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import type { ReadArtifactResponse } from "../../src/shared/artifact-ipc";
import type { ArtifactIdentity } from "../../src/domain/identity";
import type { DesktopApi } from "../../src/shared/ipc";

const project = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Omni Project",
  displayRoot: "acme-workspace",
  availability: "available" as const,
};
const registry = { status: "ready" as const, registry: { revision: 1, projects: [project], sources: [] } };
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
const observation = {
  status: "observed" as const,
  observation: {
    subject: project.ref,
    observedAt: "2026-09-12T10:00:00.000Z",
    inventory: {
      rootHandle: "grant-project",
      displayRoot: "acme-workspace",
      observedAt: "2026-09-12T10:00:00.000Z",
      harnesses: ["codex"],
      artifacts: [artifact],
      diagnostics: [],
      gitScopes: [],
    },
  },
};

function api(
  readArtifact: DesktopApi["readArtifact"] = vi
    .fn()
    .mockResolvedValue({ status: "read", content: "content", byteLength: 7, truncated: false }),
  hashArtifacts?: DesktopApi["hashArtifacts"],
): DesktopApi {
  return {
    listRegistry: vi.fn().mockResolvedValue(registry),
    registerProject: vi.fn(),
    registerSource: vi.fn(),
    openEntry: vi.fn().mockResolvedValue({ status: "granted", entry: project, grantHandle: "grant-project" }),
    observeProject: vi.fn().mockResolvedValue(observation),
    observeSource: vi.fn(),
    archiveEntry: vi.fn(),
    reactivateEntry: vi.fn(),
    readArtifact,
    hashArtifacts,
  };
}

function renderApp(desktopApi: DesktopApi): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  const root = createRoot(container);
  window.omni = desktopApi;
  document.body.append(container);
  act(() =>
    root.render(
      <ThemeProvider>
        <I18nProvider>
          <App />
        </I18nProvider>
      </ThemeProvider>,
    ),
  );
  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("asset page", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;

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

  it("opens a project artifact from the observed Workspace canvas", async () => {
    rendered = renderApp(api());
    await flush();
    expect(rendered?.container.querySelector("[data-testid='canvas-entry-project-project-one']")).not.toBeNull();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-project-project-one']")?.click(),
    );
    await flush();
    const instructionGroup = [...(rendered?.container.querySelectorAll<HTMLButtonElement>(".canvas-node") ?? [])].find(
      (button) => button.textContent?.includes("Project instructions"),
    );
    expect(instructionGroup).toBeDefined();
    act(() => instructionGroup?.click());
    await flush();
    const artifactNode = [...(rendered?.container.querySelectorAll<HTMLButtonElement>(".canvas-node") ?? [])].find(
      (button) => button.textContent?.includes("AGENTS.md"),
    );
    expect(artifactNode).toBeDefined();
    act(() => artifactNode?.click());
    await flush();

    expect(rendered?.container.querySelector("[data-testid='resource-sheet']")).not.toBeNull();
    expect(rendered?.container.querySelector(".canvas-document-toolbar code")?.textContent).toBe("AGENTS.md");
    expect(rendered?.container.querySelector(".canvas-document")?.textContent).toContain("content");
  });
});
