import { describe, expect, it } from "vitest";

import { entryForRoute, rootDestination, type Route } from "../../src/renderer/navigation";
import { navigateToRouteEffect, routeForEntry } from "../../src/renderer/app-route-effects";

describe("resource canvas routes", () => {
  it("keeps every canvas context under Home and opens exact registered entry contexts", () => {
    const source = routeForEntry({ kind: "source", id: "source-one" });
    expect(source).toEqual({
      screen: "resource-canvas",
      context: { kind: "entry", entry: { kind: "source", id: "source-one" } },
    });
    expect(rootDestination(source)).toBe("home");
    expect(entryForRoute(source)).toEqual({ kind: "source", id: "source-one" });
    const workspace: Route = { screen: "resource-canvas", context: { kind: "workspace" } };
    expect(rootDestination(workspace)).toBe("home");
    expect(entryForRoute(workspace)).toBeNull();
  });

  it("does not scan a root when opening Workspace", () => {
    let selected = 0;
    let route: Route | null = null;
    navigateToRouteEffect(
      { screen: "resource-canvas", context: { kind: "workspace" } },
      {
        selectRegistryEntry: async () => {
          selected += 1;
        },
        setRoute: (next) => {
          route = next as Route;
        },
        setRegistryError: () => undefined,
      },
    );
    expect(selected).toBe(0);
    expect(route).toEqual({ screen: "resource-canvas", context: { kind: "workspace" } });
  });
});
