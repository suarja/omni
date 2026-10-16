import { describe, expect, it } from "vitest";

import {
  entryForRoute,
  resolveLaunchDestination,
  rootDestination,
  routeForDestination,
} from "../../src/renderer/navigation";
import type { RegistryView } from "../../src/domain/project-source-registry";

const personalSource = {
  ref: { kind: "source" as const, id: "personal-source" },
  displayName: "Personal source",
  displayRoot: "personal-source",
  availability: "available" as const,
  ownership: "personal" as const,
  capabilities: { observe: true as const, write: false as const },
};

const projectEntry = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Workspace project",
  displayRoot: "workspace-project",
  availability: "available" as const,
};

const externalSource = {
  ...personalSource,
  ref: { kind: "source" as const, id: "external-source" },
  ownership: "external" as const,
  capabilities: { observe: true as const, write: false as const },
};

const registryWithPersonalSource: RegistryView = {
  revision: 1,
  projects: [],
  sources: [personalSource],
};

describe("launch navigation", () => {
  it("resolves library hierarchy routes to the library destination and source entry", () => {
    const marketplace = { screen: "marketplace" as const, sourceId: "personal-source" };
    const plugin = { screen: "package" as const, sourceId: "personal-source", packageId: "pstack" };

    expect(routeForDestination("library")).toEqual({ screen: "resource-canvas", context: { kind: "workspace" } });
    expect(routeForDestination("activity")).toEqual({
      screen: "resource-canvas",
      context: { kind: "workspace" },
      initialRailSurface: "activity",
    });
    expect(rootDestination({ screen: "activity-agents" })).toBe("activity");
    expect(rootDestination({ screen: "activity-agent", sessionId: "session-1" })).toBe("activity");
    expect(rootDestination({ screen: "activity-worktrees", projectId: "project-one" })).toBe("activity");
    expect(rootDestination(marketplace)).toBe("library");
    expect(rootDestination(plugin)).toBe("library");
    expect(
      rootDestination({
        screen: "operation-compatible",
        sourceId: "personal-source",
        harness: "codex",
        returnTo: marketplace,
      }),
    ).toBe("library");
    expect(entryForRoute(marketplace)).toEqual({ kind: "source", id: "personal-source" });
    expect(entryForRoute(plugin)).toEqual({ kind: "source", id: "personal-source" });
    expect(
      entryForRoute({
        screen: "operation-compatible",
        sourceId: "personal-source",
        packageId: "pstack",
        harness: "claude-code",
        returnTo: plugin,
      }),
    ).toEqual({ kind: "source", id: "personal-source" });
    expect(
      rootDestination({
        screen: "asset",
        artifactId: "skill",
        from: { kind: "library", sourceId: "personal-source", packageId: "pstack" },
      }),
    ).toBe("library");
  });

  it("starts at Home when an active personal source is available", () => {
    expect(resolveLaunchDestination(registryWithPersonalSource)).toBe("home");
  });

  it("opens an empty profile on the workspace without a mandatory tour", () => {
    expect(resolveLaunchDestination({ revision: 1, projects: [], sources: [] })).toBe("home");
  });

  it("opens a project-only profile on the workspace", () => {
    expect(resolveLaunchDestination({ revision: 1, projects: [projectEntry], sources: [] })).toBe("home");
  });

  it("opens an external-only profile on the workspace", () => {
    expect(resolveLaunchDestination({ revision: 1, projects: [], sources: [externalSource] })).toBe("home");
  });

  it("opens an owned profile on the workspace even when its personal source is archived", () => {
    expect(
      resolveLaunchDestination({
        revision: 1,
        projects: [],
        sources: [{ ...personalSource, archivedAt: "2026-09-10T10:00:00.000Z" }],
      }),
    ).toBe("home");
  });

  it("keeps a non-archived personal registration as the launch signal when its root is unavailable", () => {
    expect(
      resolveLaunchDestination({
        revision: 1,
        projects: [],
        sources: [{ ...personalSource, availability: "missing" }],
      }),
    ).toBe("home");
  });
});
