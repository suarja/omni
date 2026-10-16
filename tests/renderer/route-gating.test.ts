import { describe, expect, it } from "vitest";

import { gatedFallbackRoute, isRouteGated } from "../../src/renderer/features";
import { DEFAULT_FEATURES } from "../../src/shared/settings-ipc";

describe("route gating (brief A1)", () => {
  it("gates learn, activity agents, and the compose function page only while their switch is off", () => {
    expect(isRouteGated({ screen: "learn" }, DEFAULT_FEATURES)).toBe(true);
    expect(isRouteGated({ screen: "learn" }, { ...DEFAULT_FEATURES, learn: true })).toBe(false);
    expect(isRouteGated({ screen: "academy-lesson", kind: "topic", slug: "skills" }, DEFAULT_FEATURES)).toBe(true);
    expect(isRouteGated({ screen: "activity-agents" }, DEFAULT_FEATURES)).toBe(true);
    expect(isRouteGated({ screen: "activity-agents" }, { ...DEFAULT_FEATURES, activityAgents: true })).toBe(false);
    expect(isRouteGated({ screen: "activity-agent", sessionId: "s1" }, DEFAULT_FEATURES)).toBe(true);
    expect(isRouteGated({ screen: "settings-ai-function", task: "compose" }, DEFAULT_FEATURES)).toBe(true);
    expect(
      isRouteGated({ screen: "settings-ai-function", task: "compose" }, { ...DEFAULT_FEATURES, compose: true }),
    ).toBe(false);
    // Not gated: a different function task, and every other screen.
    expect(isRouteGated({ screen: "settings-ai-function", task: "explain" }, DEFAULT_FEATURES)).toBe(false);
    expect(isRouteGated({ screen: "home" }, DEFAULT_FEATURES)).toBe(false);
    expect(isRouteGated({ screen: "activity" }, DEFAULT_FEATURES)).toBe(false);
  });

  it("falls back each gated route to its destination root", () => {
    expect(gatedFallbackRoute({ screen: "learn" })).toEqual({
      screen: "resource-canvas",
      context: { kind: "workspace" },
    });
    expect(
      gatedFallbackRoute({ screen: "academy-lesson", kind: "course", slug: "skills-plugins-marketplaces" }),
    ).toEqual({ screen: "resource-canvas", context: { kind: "workspace" } });
    expect(gatedFallbackRoute({ screen: "activity-agents" })).toEqual({
      screen: "resource-canvas",
      context: { kind: "workspace" },
      initialRailSurface: "activity",
    });
    expect(gatedFallbackRoute({ screen: "activity-agent", sessionId: "s1" })).toEqual({
      screen: "resource-canvas",
      context: { kind: "workspace" },
      initialRailSurface: "activity",
    });
    expect(gatedFallbackRoute({ screen: "settings-ai-function", task: "compose" })).toEqual({
      screen: "resource-canvas",
      context: { kind: "workspace" },
      initialRailSurface: "settings",
    });
  });
});
