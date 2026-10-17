// @vitest-environment jsdom
import { act, useCallback, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectSkills } from "../../src/renderer/canvas/use-project-skills";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import type { ResourceContext } from "../../src/domain/resource-catalogue";
import type { Route } from "../../src/renderer/navigation";
import { createFixture, click, openLibrary } from "./external-library-fixture";
import { projectId, projectSnapshot } from "./project-view-fixture";

describe("external library reception reads", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    container = document.createElement("div");
    document.body.replaceChildren(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  async function mount() {
    const fixture = createFixture();
    const openEntry = vi.fn(async () => "grant");
    function Parent(): ReactElement {
      const [route, setRoute] = useState<Extract<Route, { screen: "resource-canvas" }>>({
        screen: "resource-canvas",
        context: { kind: "workspace" },
      });
      const [render, setRender] = useState(0);
      const navigate = useCallback((route: Route) => {
        if (route.screen === "resource-canvas") setRoute(route);
      }, []);
      const grant = useCallback(async () => {
        const handle = await openEntry();
        // Real grant acquisition updates App state and rebuilds its snapshot. Stop the
        // broken baseline after twelve renders so its infinite loop fails deterministically.
        if (openEntry.mock.calls.length <= 12) setRender((value) => value + 1);
        return handle;
      }, []);
      return (
        <I18nProvider initialLanguage="en">
          <button onClick={() => setRender((value) => value + 1)}>Parent render</button>
          <span data-render={render} />
          <ResourceCanvas
            api={fixture.api}
            snapshot={{ ...projectSnapshot, registry: { ...projectSnapshot.registry } }}
            {...route}
            onEnsureGrant={grant}
            onNavigate={navigate}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
          />
        </I18nProvider>
      );
    }
    await act(async () => root.render(<Parent />));
    return { ...fixture, openEntry };
  }

  async function node(selector: string): Promise<void> {
    const element = container.querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    await act(async () => element!.click());
  }
  async function idle(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
  }

  it("leaves personal marketplace observation idle until its page is opened", async () => {
    const { openEntry } = await mount();
    expect(openEntry).not.toHaveBeenCalled();
    await node("[data-kind=marketplace] .canvas-node");
    expect(openEntry).toHaveBeenCalledTimes(1);
  });

  it("bounds every IPC read through repeated workspace, project, skill, marketplace and library navigation", async () => {
    const { api, openEntry } = await mount();
    const counts = () => ({
      list: api.listExternalSources.mock.calls.length,
      source: api.readExternalSource.mock.calls.length,
      mac: api.listExternalSourcesOnMac.mock.calls.length,
      settings: api.getSettings.mock.calls.length,
      project: api.readProjectSkills.mock.calls.length,
      grants: openEntry.mock.calls.length,
      document: api.readArtifact.mock.calls.length,
      discovery: api.discoverExternalSource.mock.calls.length,
    });
    for (let cycle = 1; cycle <= 3; cycle++) {
      await node(`[data-kind=project] .canvas-node`);
      await node("[data-project-group=external] .canvas-node");
      await node("[data-skill-row-id=grill-me] .canvas-node");
      expect(container.querySelector("[data-testid=project-skill-sheet]")).not.toBeNull();
      await click(container, "Workspace");
      await node("[data-kind=marketplace] .canvas-node");
      expect(container.querySelector("[data-testid=marketplace-page]")).not.toBeNull();
      await click(container, "Workspace");
      await openLibrary(container);
      await click(container, "mattpocock/skills");
      expect(container.querySelector("[data-testid=external-source-page]")).not.toBeNull();
      await node('[data-external-skill="fresh-tool"] .canvas-node');
      expect(container.querySelector("[data-testid=external-skill-sheet]")).not.toBeNull();
      await node("[data-testid=external-skill-sheet] .canvas-sheet-header button");
      await click(container, "Workspace");
      expect(counts()).toEqual({
        list: 1,
        source: 2,
        mac: 1,
        settings: 2,
        project: cycle * 2,
        grants: cycle * 4,
        document: cycle,
        discovery: 2,
      });
      const before = counts();
      await idle();
      await click(container, "Parent render");
      await idle();
      expect(counts()).toEqual(before);
    }
  });

  it("shows loading instead of an empty project group until its first read settles", async () => {
    const fixture = createFixture();
    const data = await fixture.api.readProjectSkills(projectId);
    let finish!: (value: typeof data) => void;
    fixture.api.readProjectSkills.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      root.render(
        <I18nProvider initialLanguage="en">
          <ResourceCanvas
            api={fixture.api}
            snapshot={projectSnapshot}
            context={{ kind: "entry", entry: { kind: "project", id: projectId } }}
            onEnsureGrant={vi.fn(async () => "grant")}
            onNavigate={vi.fn()}
            onNavigateDestination={vi.fn()}
            onRefresh={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
    await node("[data-project-group=external] .canvas-node");
    expect(container.querySelector(".project-graph")?.textContent).not.toContain("No skills here");
    expect(container.querySelector(".project-graph [role=status]")?.textContent).toBe("Reading project skills…");
    await act(async () => finish(data));
    expect(container.querySelector("[data-skill-row-id=grill-me]")).not.toBeNull();
  });
  it("shares unfinished project reads between canvas and sheet consumers", async () => {
    const fixture = createFixture();
    const data = await fixture.api.readProjectSkills(projectId);
    fixture.api.readProjectSkills.mockClear();
    const pending: Array<(value: typeof data) => void> = [];
    fixture.api.readProjectSkills.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const grant = vi.fn(async () => "grant");
    function Readers(): ReactElement {
      const props = {
        api: fixture.api,
        snapshot: projectSnapshot,
        context: { kind: "workspace" as const },
        onEnsureGrant: grant,
        onNavigate: vi.fn(),
        onNavigateDestination: vi.fn(),
        onRefresh: vi.fn(),
      };
      const canvas = useProjectSkills(props, projectId);
      const sheet = useProjectSkills(props, projectId);
      return (
        <span>
          {canvas.data?.skills.length}:{sheet.data?.skills.length}
        </span>
      );
    }
    await act(async () => root.render(<Readers />));
    expect(fixture.api.readProjectSkills).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledTimes(1);
    await act(async () => pending.shift()!(data));
    expect(container.textContent).toBe(`${data.skills.length}:${data.skills.length}`);
  });
  it("queues one fresh project read when refresh is requested during an unfinished read", async () => {
    const fixture = createFixture();
    const data = await fixture.api.readProjectSkills(projectId);
    fixture.api.readProjectSkills.mockClear();
    const pending: Array<(value: typeof data) => void> = [];
    fixture.api.readProjectSkills.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    function Reader(): ReactElement {
      const props = {
        api: fixture.api,
        snapshot: projectSnapshot,
        context: { kind: "workspace" as const },
        onEnsureGrant: vi.fn(async () => "grant"),
        onNavigate: vi.fn(),
        onNavigateDestination: vi.fn(),
        onRefresh: vi.fn(),
      };
      const reader = useProjectSkills(props, projectId);
      return <button onClick={() => void reader.reload()}>Reload project</button>;
    }
    await act(async () => root.render(<Reader />));
    await click(container, "Reload project");
    await click(container, "Reload project");
    expect(fixture.api.readProjectSkills).toHaveBeenCalledTimes(1);
    await act(async () => pending.shift()!(data));
    expect(fixture.api.readProjectSkills).toHaveBeenCalledTimes(2);
    await act(async () => pending.shift()!(data));
    expect(fixture.api.readProjectSkills).toHaveBeenCalledTimes(2);
  });
});
