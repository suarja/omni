import { expect, it } from "vitest";
import { routeForDestination } from "../../src/renderer/navigation";
import { DEFAULT_FEATURES } from "../../src/shared/settings-ipc";
import { resolveCanvasRoute } from "../../src/renderer/canvas-route";
import { gatedFallbackRoute, isRouteGated } from "../../src/renderer/features";
import { fr } from "../../src/renderer/i18n/locales/fr";

it("opens every daily destination on the canvas", () => {
  for (const destination of ["home", "library", "projects", "welcome"] as const)
    expect(routeForDestination(destination)).toEqual({ screen: "resource-canvas", context: { kind: "workspace" } });
  for (const destination of ["review", "activity", "settings"] as const)
    expect(routeForDestination(destination)).toEqual({
      screen: "resource-canvas",
      context: { kind: "workspace" },
      initialRailSurface: destination,
    });
});

it("keeps public catalogue and worktree routes off by default", () => {
  expect(
    isRouteGated(
      { screen: "catalogue-entry", ownerRepo: "owner/repo", skill: "review", returnTo: routeForDestination("home") },
      DEFAULT_FEATURES,
    ),
  ).toBe(true);
  expect(isRouteGated({ screen: "activity-worktrees" }, DEFAULT_FEATURES)).toBe(true);
});

it("uses French setup copy without an English canvas fallback", () => {
  expect(fr.canvasSetup.titles.project).toBe("Ajouter un projet");
  expect(fr.canvasSetup.welcomeTitle).toBe("Bienvenue dans Omni");
});

it("keeps composition gated after a Settings link is normalized to the canvas", () => {
  const route = resolveCanvasRoute({ screen: "settings-ai-function", task: "compose" })!;
  expect(isRouteGated(route, DEFAULT_FEATURES)).toBe(true);
  expect(isRouteGated(route, { ...DEFAULT_FEATURES, compose: true })).toBe(false);
  expect(gatedFallbackRoute(route)).toEqual({
    screen: "resource-canvas",
    context: { kind: "workspace" },
    initialRailSurface: "settings",
  });
});
