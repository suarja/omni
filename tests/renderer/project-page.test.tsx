// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../src/renderer/App";
import { I18nProvider } from "../../src/renderer/i18n";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import type { DesktopApi } from "../../src/shared/ipc";

const project = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Omni Project",
  displayRoot: "acme-workspace",
  availability: "available" as const,
};
const registry = { status: "ready" as const, registry: { revision: 1, projects: [project], sources: [] } };
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
      artifacts: [],
      diagnostics: [],
      gitScopes: [{ id: "git-project", relativeRoot: ".", head: "abc1234", dirty: false as const }],
    },
  },
};

function api(): DesktopApi {
  return {
    listRegistry: vi.fn().mockResolvedValue(registry),
    registerProject: vi.fn(),
    registerSource: vi.fn(),
    openEntry: vi.fn().mockResolvedValue({ status: "granted", entry: project, grantHandle: "grant-project" }),
    observeProject: vi.fn().mockResolvedValue(observation),
    observeSource: vi.fn(),
    archiveEntry: vi.fn(),
    reactivateEntry: vi.fn(),
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

describe("project page", () => {
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

  it("opens the registered project in the Workspace canvas from Projects", async () => {
    rendered = renderApp(api());
    await flush();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-project-project-one']")?.click(),
    );
    await flush();

    expect(rendered?.container.querySelector("[data-testid='resource-canvas']")).not.toBeNull();
    expect(rendered?.container.querySelector(".canvas-breadcrumbs")?.textContent).toContain("Workspace");
    expect(rendered?.container.querySelector(".canvas-breadcrumbs")?.textContent).toContain("Omni Project");
    expect(rendered?.container.querySelector(".projects-evidence-card")).toBeNull();
  });

  it("opens the project assignment workbench from its resource details", async () => {
    rendered = renderApp(api());
    await flush();
    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>("[data-testid='canvas-entry-project-project-one']")?.click(),
    );
    await flush();

    act(() =>
      rendered?.container.querySelector<HTMLButtonElement>(".canvas-node-info[aria-label*='Omni Project']")?.click(),
    );
    act(() => {
      [...(rendered?.container.querySelectorAll<HTMLButtonElement>("button") ?? [])]
        .find((button) => button.textContent?.includes("Assign owned skills"))
        ?.click();
    });
    await flush();

    expect(rendered?.container.querySelector("[data-testid='changes-workbench']")).not.toBeNull();
  });
});
