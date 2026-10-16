import { describe, expect, it } from "vitest";
import { resolveObservedPackage } from "../../src/domain/observed-package-resolution";
import { createObservedPackage } from "../../src/domain/inventory";

const pkg = (id: string, relativeRoot = id, displayName = id, manifestId?: string) =>
  createObservedPackage({
    id,
    relativeRoot,
    displayName,
    manifestId,
    format: "omni",
    manifestPaths: [],
    artifactIds: [],
  });
const packages = [pkg("packages/build-to-show", "packages/build-to-show", "Motion tools", "explainer-motion")];

describe("observed package resolution", () => {
  it("prefers an exact observed id over another package alias", () => {
    const exact = pkg("build-to-show", "custom/root");
    expect(resolveObservedPackage([exact, ...packages], "build-to-show")).toEqual({
      status: "resolved",
      package: exact,
    });
  });
  it.each(["build-to-show", "packages/build-to-show", "Motion tools", "explainer-motion"])(
    "resolves %s to the canonical observed package",
    (alias) => expect(resolveObservedPackage(packages, alias)).toEqual({ status: "resolved", package: packages[0] }),
  );
  it("resolves a relative root that differs from the observed id", () => {
    const value = pkg("canonical", "custom/root");
    expect(resolveObservedPackage([value], "custom/root")).toEqual({ status: "resolved", package: value });
  });
  it("blocks ambiguous aliases and lists the valid ids", () => {
    const result = resolveObservedPackage([...packages, pkg("other", "other/root", "Motion tools")], "Motion tools");
    expect(result).toMatchObject({ status: "blocked", code: "package-ambiguous" });
    if (result.status !== "blocked") throw new Error("Expected a blocked package resolution.");
    expect(result.message).toContain("packages/build-to-show");
    expect(result.message).toContain("other");
  });
  it("blocks missing packages and lists at most twenty valid ids", () => {
    const result = resolveObservedPackage(
      Array.from({ length: 25 }, (_, i) => pkg(`packages/p${i}`)),
      "nope",
    );
    expect(result).toMatchObject({ status: "blocked", code: "package-not-found" });
    if (result.status !== "blocked") throw new Error("Expected a blocked package resolution.");
    expect(result.message.match(/packages\/p\d+/g)).toHaveLength(20);
  });
});
