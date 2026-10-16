import { describe, expect, it } from "vitest";

import { createActiveProjectContext, sameProjectContext } from "../../src/renderer/project-context";

const entry = {
  ref: { kind: "project" as const, id: "project-one" },
  displayName: "Omni Project",
  displayRoot: "acme-workspace",
  availability: "available" as const,
};

const opened = {
  status: "granted" as const,
  entry,
  grantHandle: "opaque-grant",
};

const observation = {
  status: "observed" as const,
  observation: {
    subject: entry.ref,
    observedAt: "2026-09-09T10:00:00.000Z",
    inventory: {
      rootHandle: "opaque-grant",
      displayRoot: "acme-workspace",
      observedAt: "2026-09-09T10:00:00.000Z",
      harnesses: ["codex"],
      artifacts: [],
      diagnostics: [],
      gitScopes: [],
    },
  },
};

describe("active project context", () => {
  it("creates context only from a granted open and observed project", () => {
    expect(createActiveProjectContext(entry, opened, observation)).toEqual({ entry, opened, observation });
    expect(
      createActiveProjectContext(entry, { status: "missing", entry, diagnostic: "Missing" }, observation),
    ).toBeNull();
    expect(
      createActiveProjectContext(entry, opened, { status: "missing", subject: entry.ref, diagnostic: "Missing" }),
    ).toBeNull();
  });

  it("matches only the same registered project reference", () => {
    const context = createActiveProjectContext(entry, opened, observation);

    expect(sameProjectContext(context, entry.ref)).toBe(true);
    expect(sameProjectContext(context, { kind: "project", id: "other-project" })).toBe(false);
    expect(sameProjectContext(context, { kind: "source", id: "project-one" })).toBe(false);
    expect(sameProjectContext(null, entry.ref)).toBe(false);
  });
});
