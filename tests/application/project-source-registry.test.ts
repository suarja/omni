import { describe, expect, it } from "vitest";

import { createInventorySnapshot } from "../../src/domain/inventory";
import { observeRegisteredEntry, type ObservationGrant } from "../../src/application/project-source-registry";
import { parseRegistryState, type EntryRef, type RegistryState } from "../../src/domain/project-source-registry";

const projectRef: EntryRef = { kind: "project", id: "project-one" };
const sourceRef: EntryRef = { kind: "source", id: "source-one" };

const state: RegistryState = parseRegistryState({
  schemaVersion: 1,
  revision: 7,
  projects: [
    {
      id: projectRef.id,
      displayName: "Project One",
      locator: { kind: "local-directory", canonicalPath: "/workspace/project-one" },
      createdAt: "2026-09-09T10:00:00.000Z",
    },
  ],
  sources: [
    {
      id: sourceRef.id,
      displayName: "Personal Sources",
      locator: { kind: "local-directory", canonicalPath: "/workspace/sources" },
      ownership: "personal",
      createdAt: "2026-09-09T10:00:00.000Z",
    },
  ],
});

function grant(subject: EntryRef, canonicalPath: string): ObservationGrant {
  return { subject, canonicalPath, rootHandle: `grant-${subject.kind}` };
}

function snapshot(scope: "project" | "source") {
  return createInventorySnapshot({
    rootHandle: `grant-${scope}`,
    displayRoot: scope === "project" ? "project-one" : "sources",
    observedAt: "2026-09-09T10:05:00.000Z",
    harnesses: [],
    artifacts: [],
    diagnostics: [],
    gitScopes: [],
  });
}

describe("registered entry observations", () => {
  it("returns an observation bound to the registered project and project scope", async () => {
    let observedRequest: Record<string, unknown> | undefined;
    const result = await observeRegisteredEntry(
      state,
      {
        subject: projectRef,
        grant: grant(projectRef, "/workspace/project-one"),
        displayRoot: "project-one",
      },
      async (request) => {
        observedRequest = request;
        return snapshot("project");
      },
    );

    expect(result).toEqual({
      status: "observed",
      observation: {
        subject: projectRef,
        observedAt: "2026-09-09T10:05:00.000Z",
        inventory: snapshot("project"),
      },
    });
    expect(observedRequest).toMatchObject({
      approvedRoot: "/workspace/project-one",
      rootHandle: "grant-project",
      displayRoot: "project-one",
      scope: "project",
    });
  });

  it("uses source scope and preserves the source identity", async () => {
    const result = await observeRegisteredEntry(
      state,
      {
        subject: sourceRef,
        grant: grant(sourceRef, "/workspace/sources"),
        displayRoot: "sources",
      },
      async () => snapshot("source"),
    );

    expect(result).toMatchObject({
      status: "observed",
      observation: { subject: sourceRef, inventory: { displayRoot: "sources" } },
    });
  });

  it("rejects a grant bound to a different entry before reading the root", async () => {
    let called = false;
    await expect(
      observeRegisteredEntry(
        state,
        {
          subject: projectRef,
          grant: grant(sourceRef, "/workspace/project-one"),
          displayRoot: "project-one",
        },
        async () => {
          called = true;
          return snapshot("project");
        },
      ),
    ).rejects.toThrow(/bound to another entry/i);
    expect(called).toBe(false);
  });

  it("returns an inaccessible result without changing registrations when a root cannot be read", async () => {
    const result = await observeRegisteredEntry(
      state,
      {
        subject: sourceRef,
        grant: grant(sourceRef, "/workspace/sources"),
        displayRoot: "sources",
      },
      async () => {
        throw new Error("root disappeared");
      },
    );

    expect(result).toEqual({
      status: "inaccessible",
      subject: sourceRef,
      diagnostic: "The registered root could not be observed.",
    });
    expect(state.sources[0]?.archivedAt).toBeUndefined();
  });
});
