import { describe, expect, it } from "vitest";

import {
  createRegistryView,
  parseRegistryState,
  registerProject,
  registerSource,
  type RegistryState,
} from "../../src/domain/project-source-registry";

const project = {
  id: "project-one",
  displayName: "Project One",
  locator: { kind: "local-directory", canonicalPath: "/workspace/project-one" },
  createdAt: "2026-09-09T10:00:00.000Z",
};

const source = {
  id: "source-one",
  displayName: "Personal Sources",
  locator: { kind: "local-directory", canonicalPath: "/workspace/sources" },
  ownership: "personal" as const,
  createdAt: "2026-09-09T10:00:00.000Z",
};

function stateWith(projects: readonly unknown[] = [project], sources: readonly unknown[] = [source]): RegistryState {
  return parseRegistryState({
    schemaVersion: 1,
    revision: 4,
    projects,
    sources,
  });
}

describe("project and source registry domain", () => {
  it("parses durable registrations and returns redacted views", () => {
    const state = stateWith();
    const view = createRegistryView(state);

    expect(view).toEqual({
      revision: 4,
      projects: [
        {
          ref: { kind: "project", id: "project-one" },
          displayName: "Project One",
          displayRoot: "project-one",
          availability: "available",
        },
      ],
      sources: [
        {
          ref: { kind: "source", id: "source-one" },
          displayName: "Personal Sources",
          displayRoot: "sources",
          availability: "available",
          ownership: "personal",
          capabilities: { observe: true, write: false },
        },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("canonicalPath");
  });

  it.each([
    ["unknown registry field", { extra: true }],
    ["unknown registration field", { extra: true }],
    ["unknown locator field", { extra: true }],
  ])("rejects %s", (label, extra) => {
    const value =
      label === "unknown registry field"
        ? { schemaVersion: 1, revision: 0, projects: [], sources: [], ...extra }
        : {
            schemaVersion: 1,
            revision: 0,
            projects: [
              {
                ...project,
                ...(label === "unknown locator field" ? { locator: { ...project.locator, ...extra } } : extra),
              },
            ],
            sources: [],
          };

    expect(() => parseRegistryState(value)).toThrow(/unknown field/i);
  });

  it("rejects unsupported schema, malformed ids, and relative paths", () => {
    expect(() =>
      parseRegistryState({
        schemaVersion: 2,
        revision: 0,
        projects: [],
        sources: [],
      }),
    ).toThrow(/schema/i);
    expect(() =>
      parseRegistryState({
        schemaVersion: 1,
        revision: 0,
        projects: [{ ...project, id: "not a valid id" }],
        sources: [],
      }),
    ).toThrow(/id/i);
    expect(() =>
      parseRegistryState({
        schemaVersion: 1,
        revision: 0,
        projects: [{ ...project, locator: { kind: "local-directory", canonicalPath: "relative/path" } }],
        sources: [],
      }),
    ).toThrow(/absolute/i);
  });

  it("rejects duplicate ids and duplicate active locators", () => {
    expect(() => stateWith([{ ...project }, { ...project, id: "project-two" }], [])).toThrow(/locator/i);
    expect(() =>
      stateWith(
        [
          { ...project },
          { ...project, id: "project-two", locator: { ...project.locator, canonicalPath: "/workspace/other" } },
        ],
        [{ ...source, id: "project-one" }],
      ),
    ).toThrow(/id/i);
  });

  it("allows archived duplicate locators while preserving strict records", () => {
    const state = stateWith(
      [project, { ...project, id: "project-archived", archivedAt: "2026-09-09T11:00:00.000Z" }],
      [],
    );

    expect(state.projects).toHaveLength(2);
  });

  it("reactivates an archived project with its stable identity", () => {
    const initial = stateWith([{ ...project, archivedAt: "2026-09-09T11:00:00.000Z" }], []);

    const decision = registerProject(initial, {
      displayName: "Renamed Project",
      canonicalPath: project.locator.canonicalPath,
      createdAt: "2026-09-09T12:00:00.000Z",
    });

    expect(decision.result).toMatchObject({
      outcome: "reactivated",
      entry: {
        ref: { kind: "project", id: "project-one" },
        displayName: "Renamed Project",
        displayRoot: "project-one",
      },
    });
    expect(decision.nextState.projects).toEqual([{ ...project, displayName: "Renamed Project" }]);
    expect(decision.nextState.revision).toBe(initial.revision);
    expect(JSON.stringify(decision.result)).not.toContain("canonicalPath");
  });

  it("returns existing for an active project and keeps the state revision unchanged", () => {
    const existingState = stateWith(
      [
        {
          ...project,
          id: "project-two",
          displayName: "Project Two",
          locator: { ...project.locator, canonicalPath: "/workspace/project-two" },
        },
      ],
      [],
    );
    const existing = registerProject(existingState, {
      id: "project-two",
      displayName: "Project Two",
      canonicalPath: "/workspace/project-two",
      createdAt: "2026-09-09T12:00:00.000Z",
    });
    const repeated = registerProject(existingState, {
      displayName: "Ignored Rename",
      canonicalPath: "/workspace/project-two",
      createdAt: "2026-09-09T13:00:00.000Z",
    });
    expect(repeated.result).toMatchObject({
      outcome: "existing",
      entry: { ref: { id: "project-two" }, displayName: "Project Two" },
    });
    expect(repeated.nextState).toEqual(existingState);
    expect(repeated.nextState.revision).toBe(existingState.revision);
    expect(JSON.stringify(existing.result)).not.toContain("canonicalPath");

    const sourceState = stateWith(
      [],
      [
        {
          id: "source-two",
          displayName: "External",
          locator: { kind: "local-directory", canonicalPath: "/workspace/source-two" },
          ownership: "external",
          createdAt: "2026-09-09T12:00:00.000Z",
        },
      ],
    );
    const sourceResult = registerSource(sourceState, {
      displayName: "Personal",
      canonicalPath: "/workspace/source-two",
      ownership: "personal",
      createdAt: "2026-09-09T13:00:00.000Z",
    });
    expect(sourceResult.result).toMatchObject({
      status: "classification-conflict",
      entry: {
        ref: { kind: "source", id: "source-two" },
        ownership: "external",
        displayRoot: "source-two",
      },
    });
    expect(sourceResult.nextState).toEqual(sourceState);
    expect(sourceResult.nextState.revision).toBe(sourceState.revision);
    expect(JSON.stringify(sourceResult.result)).not.toContain("canonicalPath");
  });

  it("returns a created project nextState without exposing its canonical path", () => {
    const initial = stateWith([], []);
    const decision = registerProject(initial, {
      id: "project-created",
      displayName: "Created Project",
      canonicalPath: "/workspace/created-project",
      createdAt: "2026-09-09T12:00:00.000Z",
    });

    expect(decision.result).toMatchObject({
      outcome: "created",
      entry: { ref: { id: "project-created" }, displayRoot: "created-project" },
    });
    expect(decision.nextState.projects).toHaveLength(1);
    expect(decision.nextState.projects[0]?.locator.canonicalPath).toBe("/workspace/created-project");
    expect(decision.nextState.revision).toBe(initial.revision);
    expect(JSON.stringify(decision.result)).not.toContain("canonicalPath");
  });

  it("returns source lifecycle decisions with internal next states", () => {
    const initial = stateWith([], []);
    const created = registerSource(initial, {
      id: "source-created",
      displayName: "External",
      canonicalPath: "/workspace/source-created",
      ownership: "external",
      createdAt: "2026-09-09T12:00:00.000Z",
    });
    const existing = registerSource(created.nextState, {
      displayName: "Ignored Rename",
      canonicalPath: "/workspace/source-created",
      ownership: "external",
      createdAt: "2026-09-09T13:00:00.000Z",
    });
    const archivedState = parseRegistryState({
      ...created.nextState,
      sources: [{ ...created.nextState.sources[0], archivedAt: "2026-09-09T14:00:00.000Z" }],
    });
    const reactivated = registerSource(archivedState, {
      displayName: "Renamed External",
      canonicalPath: "/workspace/source-created",
      ownership: "external",
      createdAt: "2026-09-09T15:00:00.000Z",
    });

    expect(created.result).toMatchObject({ outcome: "created", entry: { ref: { id: "source-created" } } });
    expect(existing.result).toMatchObject({ outcome: "existing", entry: { ref: { id: "source-created" } } });
    expect(existing.nextState).toEqual(created.nextState);
    expect(reactivated.result).toMatchObject({ outcome: "reactivated", entry: { displayName: "Renamed External" } });
    expect(reactivated.nextState.sources[0]).toMatchObject({ id: "source-created", displayName: "Renamed External" });
    expect(reactivated.nextState.revision).toBe(archivedState.revision);
    expect(JSON.stringify(created.result)).not.toContain("canonicalPath");
  });

  it("prefers an active match when an archived duplicate appears first", () => {
    const state = stateWith(
      [
        { ...project, id: "archived-project", archivedAt: "2026-09-09T11:00:00.000Z" },
        { ...project, id: "active-project" },
      ],
      [],
    );

    expect(
      registerProject(state, {
        displayName: "Project One",
        canonicalPath: project.locator.canonicalPath,
        createdAt: "2026-09-09T12:00:00.000Z",
      }).result,
    ).toMatchObject({
      outcome: "existing",
      entry: { ref: { kind: "project", id: "active-project" } },
    });
  });

  it.each([
    "/workspace/project\u0000",
    "/workspace/project\u0001",
    "/workspace/project/../other",
    "/workspace//project",
  ])("rejects unsafe canonical path %s", (canonicalPath) => {
    expect(() =>
      parseRegistryState({
        schemaVersion: 1,
        revision: 0,
        projects: [{ ...project, locator: { kind: "local-directory", canonicalPath } }],
        sources: [],
      }),
    ).toThrow(/path|control|unsafe/i);
  });

  it("preserves availability distinctions in views", () => {
    const view = createRegistryView(stateWith(), (entry) =>
      entry.canonicalPath.endsWith("sources") ? "inaccessible" : "missing",
    );

    expect(view.projects[0]?.availability).toBe("missing");
    expect(view.sources[0]?.availability).toBe("inaccessible");
  });
});
