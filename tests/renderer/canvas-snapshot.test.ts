import { describe, expect, it } from "vitest";

import { resourceFixture } from "../fixtures/resource-catalogue";
import { createResourceSnapshot } from "../../src/renderer/canvas/resource-snapshot";

describe("resource snapshot composition", () => {
  it("prefers explicit current outcomes, then matching audit observations, and scopes loading", () => {
    const snapshot = createResourceSnapshot({
      registry: resourceFixture.registry,
      observations: {
        "source:source-one": { status: "inaccessible", subject: resourceFixture.sourceRef, diagnostic: "Denied now" },
      },
      auditObservations: [resourceFixture.sourceObservation, resourceFixture.projectObservation],
      pendingObservations: { "project:project-two": true },
      uses: { status: "ready", bindings: resourceFixture.bindings },
    });
    expect(snapshot.roots).toEqual([
      { entry: resourceFixture.sourceRef, evidence: { status: "unavailable", reason: "inaccessible" } },
      {
        entry: resourceFixture.projectOneRef,
        evidence: {
          status: "observed",
          observation: expect.objectContaining({ subject: resourceFixture.projectOneRef }),
        },
      },
      { entry: resourceFixture.projectTwoRef, evidence: { status: "loading" } },
    ]);
  });

  it("does not attach a mismatched audit observation or invent an empty binding read", () => {
    const snapshot = createResourceSnapshot({
      registry: resourceFixture.registry,
      observations: {},
      auditObservations: [resourceFixture.sourceObservation],
      pendingObservations: {},
      uses: { status: "unavailable" },
    });
    expect(snapshot.roots.find((root) => root.entry.id === "project-one")?.evidence).toEqual({ status: "unobserved" });
    expect(snapshot.uses).toEqual({ status: "unavailable" });
  });
});
