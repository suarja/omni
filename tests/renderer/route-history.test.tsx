// @vitest-environment jsdom

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRouteHistory } from "../../src/renderer/use-route-history";
import type { Route } from "../../src/renderer/navigation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HarnessState = Readonly<{
  canGoBack: boolean;
  canGoForward?: boolean;
  onForward?: () => void;
  navigate: (route: Route) => void;
  onBack: () => void;
  route: Route;
}>;

function Harness({
  initialRoute,
  onState,
}: Readonly<{ initialRoute: Route; onState: (state: HarnessState) => void }>): ReactElement | null {
  const [route, setRoute] = useState<Route>(initialRoute);
  const history = useRouteHistory(route, setRoute);
  onState({ ...history, navigate: setRoute, route });
  return null;
}

function render(initialRoute: Route): { container: HTMLDivElement; root: Root; latest: () => HarnessState } {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  let state: HarnessState | undefined;
  act(() => root.render(<Harness initialRoute={initialRoute} onState={(next) => (state = next)} />));
  return { container, root, latest: () => state! };
}

describe("useRouteHistory (D3)", () => {
  let rendered: { container: HTMLDivElement; root: Root; latest: () => HarnessState } | undefined;

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterEach(() => {
    act(() => rendered?.root.unmount());
    rendered?.container.remove();
    rendered = undefined;
    vi.restoreAllMocks();
  });

  it("hides Back at the root of a destination", () => {
    rendered = render({ screen: "library", tab: "marketplaces" });
    expect(rendered.latest().canGoBack).toBe(false);
  });

  it("pushes the previous route on every screen change within a destination, then pops on back", () => {
    rendered = render({ screen: "library", tab: "marketplaces" });
    act(() => rendered?.latest().navigate({ screen: "marketplace", sourceId: "source-one" }));
    expect(rendered.latest().canGoBack).toBe(true);
    act(() => rendered?.latest().navigate({ screen: "package", sourceId: "source-one", packageId: "pkg-one" }));
    expect(rendered.latest().canGoBack).toBe(true);
    expect(rendered.latest().route).toEqual({ screen: "package", sourceId: "source-one", packageId: "pkg-one" });

    act(() => rendered?.latest().onBack());
    expect(rendered.latest().route).toEqual({ screen: "marketplace", sourceId: "source-one" });
    expect(rendered.latest().canGoBack).toBe(true);

    act(() => rendered?.latest().onBack());
    expect(rendered.latest().route).toEqual({ screen: "library", tab: "marketplaces" });
    expect(rendered.latest().canGoBack).toBe(false);
  });

  it("does not push when the route is set to the same value", () => {
    rendered = render({ screen: "library", tab: "marketplaces" });
    act(() => rendered?.latest().navigate({ screen: "marketplace", sourceId: "source-one" }));
    act(() => rendered?.latest().navigate({ screen: "marketplace", sourceId: "source-one" }));
    expect(rendered.latest().canGoBack).toBe(true);
    act(() => rendered?.latest().onBack());
    expect(rendered.latest().route).toEqual({ screen: "library", tab: "marketplaces" });
    expect(rendered.latest().canGoBack).toBe(false);
  });

  it("resets the stack when the sidebar destination changes — a destination is a root", () => {
    rendered = render({ screen: "library", tab: "marketplaces" });
    act(() => rendered?.latest().navigate({ screen: "marketplace", sourceId: "source-one" }));
    expect(rendered.latest().canGoBack).toBe(true);

    // Switching to a different destination (Projects) is a sidebar navigation, not a Back step:
    // the new destination is its own root, so Back is hidden there even though Library had history.
    act(() => rendered?.latest().navigate({ screen: "projects" }));
    expect(rendered.latest().canGoBack).toBe(false);

    act(() => rendered?.latest().navigate({ screen: "project", projectId: "project-one", tab: "overview" }));
    expect(rendered.latest().canGoBack).toBe(true);
    act(() => rendered?.latest().onBack());
    expect(rendered.latest().route).toEqual({ screen: "projects" });
    expect(rendered.latest().canGoBack).toBe(false);
  });

  it("calling onBack with an empty stack is a no-op", () => {
    rendered = render({ screen: "home" });
    act(() => rendered?.latest().onBack());
    expect(rendered.latest().route).toEqual({ screen: "home" });
    expect(rendered.latest().canGoBack).toBe(false);
  });
  it("replays canvas pages and their skill sheets forward, and clears forward history on a new destination", () => {
    const workspace: Route = { screen: "resource-canvas", context: { kind: "workspace" } };
    const library: Route = { ...workspace, canvasPage: { kind: "library" } };
    const source: Route = {
      ...workspace,
      canvasPage: { kind: "source", sourceId: "owner/repo" },
      initialExternalSelection: { sourceId: "owner/repo", skillName: "review", view: "skill" },
    };
    rendered = render(workspace);
    act(() => rendered!.latest().navigate(library));
    act(() => rendered!.latest().navigate(source));
    act(() => rendered!.latest().onBack());
    expect(rendered.latest().route).toEqual(library);
    expect(rendered.latest().canGoForward).toBe(true);
    act(() => rendered!.latest().onForward!());
    expect(rendered.latest().route).toEqual(source);
    act(() => rendered!.latest().onBack());
    act(() => rendered!.latest().navigate({ ...workspace, canvasPage: { kind: "marketplace" } }));
    expect(rendered.latest().canGoForward).toBe(false);
  });
});
