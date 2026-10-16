// @vitest-environment jsdom

import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { otherSkillRef, resourceFixture, snapshot } from "../fixtures/resource-catalogue";
import type { ResourceContext } from "../../src/domain/resource-catalogue";
import { I18nProvider } from "../../src/renderer/i18n";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import type { Route } from "../../src/renderer/navigation";
import type { ReadArtifactResponse } from "../../src/shared/artifact-ipc";

describe("resource canvas", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onNavigate: ReturnType<typeof vi.fn<(route: Route) => void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    onNavigate = vi.fn<(route: Route) => void>();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => act(() => root.unmount()));

  function render(
    context: ResourceContext = { kind: "workspace" },
    response: ReadArtifactResponse = { status: "read", content: "# Actual text", byteLength: 13, truncated: false },
  ): void {
    act(() =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={{ readArtifact: vi.fn<() => Promise<ReadArtifactResponse>>().mockResolvedValue(response) }}
            context={context}
            onEnsureGrant={vi.fn(async () => "grant")}
            onNavigate={onNavigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            snapshot={snapshot}
          />
        </I18nProvider>,
      ),
    );
  }

  it("shows an unavailable document with retry when the reader rejects invalid metadata", async () => {
    await act(async () =>
      render(
        { kind: "artifact", entry: resourceFixture.sourceRef, artifactId: "skill-one" },
        { status: "corrupt", diagnostic: "Artifact metadata is invalid.", recoveryAvailable: false },
      ),
    );
    expect(container.textContent).toContain("The document is unavailable.");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);
  });

  it("renders the actual Markdown title inside a document sheet", async () => {
    await act(async () =>
      render(otherSkillRef, {
        status: "read",
        content: "# Actual title\n\n## Steps\n\n- First\n- Second",
        byteLength: 45,
        truncated: false,
      }),
    );
    expect(container.querySelector(".canvas-document h1")?.textContent).toBe("Actual title");
    expect(container.querySelectorAll(".canvas-document ul li")).toHaveLength(2);
  });

  it("shows registered entries and opens My Marketplace while retaining separate information controls", () => {
    render();
    const source = [...container.querySelectorAll<HTMLButtonElement>(".canvas-node")].find((node) =>
      node.textContent?.includes("Personal Skills"),
    );
    expect(source).toBeDefined();
    expect(source?.querySelector("button")).toBeNull();
    expect(source?.closest(".canvas-node-row")?.querySelectorAll("button")).toHaveLength(2);
    act(() => source?.click());
    expect(container.querySelector("[data-testid=my-marketplace-sheet]")).toBeNull();
    expect(onNavigate).toHaveBeenCalledWith({
      screen: "resource-canvas",
      context: { kind: "workspace" },
      canvasPage: { kind: "marketplace" },
    });
  });

  it("keeps persisted uses distinct from provider-loaded state in information", () => {
    render({ kind: "entry", entry: resourceFixture.sourceRef });
    const info = [...container.querySelectorAll<HTMLButtonElement>(".canvas-node-info")].find((button) =>
      button.getAttribute("aria-label")?.includes("Personal Skills"),
    );
    act(() => info?.click());
    expect(container.textContent).toContain("Persisted uses");
    expect(container.textContent).toContain("Project One · Codex");
    expect(container.textContent).toContain("Provider-loaded state is not supplied by these bindings.");
    expect(container.textContent).not.toContain("Synchronized");
  });

  it("opens cached search with Command+K and routes a qualified result", () => {
    render();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })));
    const input = container.querySelector<HTMLInputElement>(".canvas-search-input input");
    expect(input).not.toBeNull();
    act(() => {
      if (input) {
        input.value = "review";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    const result = [...container.querySelectorAll<HTMLButtonElement>(".canvas-search-result")].find((button) =>
      button.textContent?.includes("plugins/other/skills"),
    );
    expect(result).not.toBeNull();
    act(() => result?.click());
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        screen: "resource-canvas",
        context: { kind: "workspace" },
        canvasPage: { kind: "marketplace" },
        initialMarketplaceSkill: { packageId: "other", path: "plugins/other/skills/review/SKILL.md" },
      }),
    );
  });

  it("opens a directly routed artifact with its Document tab selected on first render", async () => {
    const readArtifact = vi
      .fn()
      .mockResolvedValue({ status: "read", content: "# Real document", byteLength: 15, truncated: false });
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={{ readArtifact }}
            context={otherSkillRef}
            onEnsureGrant={vi.fn(async () => "fresh-grant")}
            onNavigate={onNavigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            snapshot={snapshot}
          />
        </I18nProvider>,
      ),
    );

    expect(container.querySelector(".canvas-sheet-tabs button[aria-current='page']")?.textContent).toBe("Document");
    expect(document.activeElement).toBe(container.querySelector(".canvas-sheet-header button"));
    expect(readArtifact).toHaveBeenCalledWith({
      kind: "source",
      id: "source-one",
      grantHandle: "fresh-grant",
      relativePath: "plugins/other/skills/review/SKILL.md",
    });
  });

  it("does not restart a file read when grant acquisition refreshes equivalent qualified refs", async () => {
    const readArtifact = vi.fn().mockResolvedValue({
      status: "read",
      content: "# One read\n\nThe read completed.",
      byteLength: 30,
      truncated: false,
    });
    const api = { readArtifact };
    let refreshed = false;
    function Parent(): React.ReactElement {
      const [revision, setRevision] = useState(0);
      const ensureGrant = useCallback(async () => {
        if (!refreshed) {
          refreshed = true;
          setRevision(1);
        }
        return "fresh-grant";
      }, []);
      const currentSnapshot = revision === 0 ? snapshot : { ...snapshot, registry: { ...snapshot.registry } };
      return (
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={api}
            context={otherSkillRef}
            onEnsureGrant={ensureGrant}
            onNavigate={onNavigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            snapshot={currentSnapshot}
          />
        </I18nProvider>
      );
    }
    await act(async () => {
      root.render(<Parent />);
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });

    expect(readArtifact).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("The read completed.");
  });

  it("moves focus into an information sheet and restores it to the originating info control", async () => {
    render({ kind: "entry", entry: resourceFixture.sourceRef });
    const info = [...container.querySelectorAll<HTMLButtonElement>(".canvas-node-info")].find((button) =>
      button.getAttribute("aria-label")?.includes("Personal Skills"),
    );
    expect(info).toBeDefined();
    act(() => {
      info?.focus();
      info?.click();
    });
    const close = container.querySelector<HTMLButtonElement>(".canvas-sheet-header button");
    expect(document.activeElement).toBe(close);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(info);

    act(() => {
      info?.focus();
      info?.click();
    });
    const reopenedClose = container.querySelector<HTMLButtonElement>(".canvas-sheet-header button");
    expect(document.activeElement).toBe(reopenedClose);
    await act(async () => {
      reopenedClose?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement).toBe(info);
  });

  it("restores focus to the artifact node after Back returns to its parent package", async () => {
    const readArtifact = vi
      .fn()
      .mockResolvedValue({ status: "read", content: "# Skill\n\nBody.", byteLength: 14, truncated: false });
    function HistoryCanvas(): React.ReactElement {
      const [context, setContext] = useState<ResourceContext>(otherSkillRef);
      const goBack = useCallback(
        () => setContext({ kind: "package", entry: resourceFixture.sourceRef, packageId: "other" }),
        [],
      );
      return (
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={{ readArtifact }}
            context={context}
            onBack={goBack}
            onEnsureGrant={vi.fn(async () => "grant")}
            onNavigate={onNavigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
            snapshot={snapshot}
          />
        </I18nProvider>
      );
    }
    await act(async () => root.render(<HistoryCanvas />));
    expect(document.activeElement).toBe(container.querySelector(".canvas-sheet-header button"));
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".canvas-sheet-header button")?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement?.closest(".canvas-node-row")?.getAttribute("data-node-key")).toBe(
      JSON.stringify(otherSkillRef),
    );
  });
});
