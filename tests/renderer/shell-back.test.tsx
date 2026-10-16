// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Observation, RegistryView } from "../../src/domain/project-source-registry";
import type { ObservedArtifact } from "../../src/domain/inventory";
import { App } from "../../src/renderer/App";
import { I18nProvider } from "../../src/renderer/i18n";
import { ThemeProvider } from "../../src/renderer/theme/theme-provider";
import type { DesktopApi } from "../../src/shared/ipc";

const personal = {
  ref: { kind: "source" as const, id: "personal-source" },
  displayName: "My Skills",
  displayRoot: "my-skills",
  availability: "available" as const,
  ownership: "personal" as const,
  capabilities: { observe: true as const, write: false as const },
};

const artifact: ObservedArtifact = {
  id: "artifact-skill",
  physicalIdentity: "skills/review/SKILL.md",
  projectionPaths: ["skills/review/SKILL.md"],
  kind: "skill",
  relativePath: "skills/review/SKILL.md",
  displayPath: "skills/review/SKILL.md",
  providerIds: ["codex"],
  scope: "source",
  confidence: "exact",
  symlinkState: "none",
};

function registry(): RegistryView {
  return { revision: 1, projects: [], sources: [personal] };
}

function observation(subject: Observation["subject"]): Observation {
  return {
    subject,
    observedAt: "2026-09-11T10:00:00.000Z",
    inventory: {
      rootHandle: "opaque-grant",
      displayRoot: subject.id,
      observedAt: "2026-09-11T10:00:00.000Z",
      harnesses: ["codex"],
      artifacts: [artifact],
      diagnostics: [],
      gitScopes: [],
    },
  };
}

type Rendered = Readonly<{ container: HTMLDivElement; root: Root }>;

function requireButton(container: HTMLElement, selector: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Expected button ${selector} to be rendered.`);
  return button;
}

function clickButton(container: HTMLElement, selector: string): void {
  const button = requireButton(container, selector);
  act(() => button.click());
}

function render(element: React.ReactElement): Rendered {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  act(() => root.render(<I18nProvider>{element}</I18nProvider>));
  return { container, root };
}

describe("shell Back control (D3)", () => {
  let rendered: Rendered | undefined;

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

  it("uses breadcrumbs and keyboard shortcuts to return from a marketplace without a toolbar Back button", async () => {
    const api: DesktopApi = {
      listRegistry: vi.fn().mockResolvedValue({ status: "ready", registry: registry() }),
      registerProject: vi.fn(),
      registerSource: vi.fn(),
      archiveEntry: vi.fn(),
      reactivateEntry: vi.fn(),
      openEntry: vi.fn().mockResolvedValue({ status: "granted", entry: personal, grantHandle: "source-grant" }),
      observeProject: vi.fn(),
      observeSource: vi.fn().mockResolvedValue({ status: "observed", observation: observation(personal.ref) }),
    };
    window.omni = api;
    rendered = render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The canvas is the fresh workspace root, so Back is absent at launch.
    expect(rendered.container.querySelector("[data-testid='resource-canvas']")).not.toBeNull();
    expect(rendered.container.querySelector(".canvas-header [aria-label='Back']")).toBeNull();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // Library is the destination root reached through the canvas destinations menu.
    expect(rendered.container.querySelector("[data-testid='resource-canvas']")).not.toBeNull();
    expect(rendered.container.querySelector(".canvas-header [aria-label='Back']")).toBeNull();

    clickButton(rendered.container, "[data-testid='canvas-entry-source-personal-source']");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The workspace breadcrumb returns from the marketplace.
    expect(rendered.container.querySelector("[data-testid='resource-canvas']")).not.toBeNull();
    expect(rendered.container.querySelector(".canvas-header [aria-label='Back']")).toBeNull();
    const workspace = requireButton(rendered.container, ".canvas-breadcrumbs button");
    expect(workspace.textContent).toBe("Workspace");
    act(() => workspace.click());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='canvas-entry-source-personal-source']")).not.toBeNull();
    expect(rendered.container.querySelector(".canvas-header [aria-label='Back']")).toBeNull();

    // The keyboard shortcut (Alt+ArrowLeft) drives the same Back path.
    clickButton(rendered.container, "[data-testid='canvas-entry-source-personal-source']");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='resource-canvas']")).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { altKey: true, key: "ArrowLeft", bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(rendered.container.querySelector("[data-testid='canvas-entry-source-personal-source']")).not.toBeNull();
    expect(rendered.container.querySelector(".canvas-header [aria-label='Back']")).toBeNull();
  });
});
