import { describe, expect, it } from "vitest";
import {
  classifyExternalUse,
  externalReadCopyFolder,
  parseExternalRepository,
  projectExternalUseState,
} from "../../src/domain/external-library";

describe("external library rules", () => {
  it("uses one normalized safe folder identity for external read copies", () => {
    expect(externalReadCopyFolder("Owner/Tools")).toBe("owner__tools");
    expect(() => externalReadCopyFolder("../tools")).toThrow();
  });
  it("normalizes owner repositories and GitHub URLs without accepting other destinations", () => {
    for (const input of ["Owner/Tools", "https://github.com/Owner/Tools.git", "https://github.com/Owner/Tools/"])
      expect(parseExternalRepository(input)).toBe("owner/tools");
    for (const input of [
      "../tools",
      "https://other.test/a/b",
      "https://user:secret@github.com/a/b",
      "a/b?x=1",
      "a/b/c",
      "-a/b",
    ])
      expect(() => parseExternalRepository(input)).toThrow();
  });

  it("classifies complete evidence and refuses missing or failed observations", () => {
    expect(classifyExternalUse({ lock: "base", copy: "base", source: "base" })).toEqual({
      state: "up-to-date",
      sourceChanged: false,
    });
    expect(classifyExternalUse({ lock: "base", copy: "base", source: "next" })).toEqual({
      state: "update",
      sourceChanged: true,
    });
    expect(classifyExternalUse({ lock: "base", copy: "local", source: "base" })).toEqual({
      state: "modified",
      sourceChanged: false,
    });
    expect(classifyExternalUse({ lock: "base", copy: "local", source: "next" })).toEqual({
      state: "modified",
      sourceChanged: true,
    });
    expect(classifyExternalUse({ lock: "base", copy: "local", source: "local" })).toEqual({
      state: "modified",
      sourceChanged: true,
    });
    expect(classifyExternalUse({ lock: "base", copy: "base", removed: true })).toEqual({
      state: "removed",
      sourceChanged: true,
    });
    expect(classifyExternalUse({ lock: "base", copy: "base" }).state).toBe("unknown");
    expect(classifyExternalUse({ lock: "base", source: "base" }).state).toBe("unknown");
    expect(classifyExternalUse({ lock: "base", copy: "base", source: "next", failed: true }).state).toBe("unknown");
  });

  it("projects every upstream state into the existing project row contract", () => {
    expect(
      ["up-to-date", "update", "modified", "removed", "unknown"].map((state) =>
        projectExternalUseState(state as never),
      ),
    ).toEqual(["current", "update-available", "modified-here", "removed-upstream", "unknown"]);
  });
});
