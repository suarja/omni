import { describe, expect, it } from "vitest";
import {
  readSourceSkillObservation,
  sourceReferenceRecovery,
} from "../../src/main/skill-management/source-observation";
import { observedSourcePath } from "../../src/main/skill-management/adoption-reader";
import { createInventorySnapshot } from "../../src/domain/inventory";
import type { ObservationResponse } from "../../src/shared/registry-ipc";

const source = { sourceId: "personal", packageId: "tools", artifactPath: "skills/demo" };
const artifact = {
  id: "demo",
  physicalIdentity: "packages/tools/skills/demo/SKILL.md",
  projectionPaths: ["packages/tools/skills/demo/SKILL.md"],
  kind: "skill",
  relativePath: "packages/tools/skills/demo/SKILL.md",
  displayPath: "packages/tools/skills/demo/SKILL.md",
  providerIds: [],
  scope: "source",
  confidence: "exact",
  symlinkState: "none",
  packageId: "packages/tools",
};
const pkg = {
  id: "packages/tools",
  relativeRoot: "packages/tools",
  displayName: "Tools",
  format: "omni",
  manifestPaths: [],
  artifactIds: ["demo"],
};
function observed(overrides: Record<string, unknown> = {}): ObservationResponse {
  return {
    status: "observed",
    observation: {
      subject: { kind: "source", id: "personal" },
      observedAt: "2026-10-14T00:00:00Z",
      inventory: createInventorySnapshot({
        rootHandle: "root",
        displayRoot: "fixture",
        observedAt: "2026-10-14T00:00:00Z",
        harnesses: [],
        artifacts: [artifact],
        packages: [pkg],
        diagnostics: [],
        gitScopes: [],
        ...overrides,
      }),
    },
  };
}
const read = (value: ObservationResponse, ref = source) => readSourceSkillObservation(value, ref, observedSourcePath);
const diagnostic = (location: string) => ({
  location,
  code: "inaccessible",
  severity: "error",
  message: "Fixture unreadable.",
});

describe("exact source skill observation", () => {
  it("resolves a short package id before locating the exact skill", () => {
    expect(read(observed())).toEqual({ status: "ready", folderPath: "packages/tools/skills/demo" });
  });
  it("reports missing packages with valid ids and refresh recovery", () => {
    const result = read(observed(), { ...source, packageId: "nope" });
    expect(result).toMatchObject({
      status: "blocked",
      code: "package-not-found",
      message: expect.stringContaining(pkg.id),
    });
    if (result.status !== "blocked") throw new Error("Expected blocked observation.");
    expect(sourceReferenceRecovery(result.code)).toBe("refresh");
  });
  it("reports ambiguous manifest aliases without reconnect", () => {
    expect(
      read(observed({ packages: [pkg, { ...pkg, id: "other", relativeRoot: "other/root", artifactIds: [] }] }), {
        ...source,
        packageId: "Tools",
      }),
    ).toMatchObject({ status: "blocked", code: "package-ambiguous" });
    expect(sourceReferenceRecovery("package-ambiguous")).toBe("refresh");
  });
  it("reports missing skill folders without reconnect", () => {
    expect(read(observed({ artifacts: [] }))).toMatchObject({ status: "blocked", code: "source-skill-unavailable" });
    expect(sourceReferenceRecovery("source-skill-unavailable")).toBe("refresh");
  });
  it("reports ambiguous skill folders without trying a fallback path", () => {
    expect(
      read(
        observed({
          artifacts: [artifact, { ...artifact, id: "duplicate", physicalIdentity: "alias" }],
          packages: [{ ...pkg, artifactIds: ["demo", "duplicate"] }],
        }),
      ),
    ).toMatchObject({ status: "blocked", code: "source-skill-unavailable" });
  });
  it("keeps incomplete observation when a diagnostic hides the skill", () => {
    expect(read(observed({ artifacts: [], diagnostics: [diagnostic("packages/tools/skills/demo")] }))).toMatchObject({
      status: "blocked",
      code: "source-observation-incomplete",
    });
    expect(sourceReferenceRecovery("source-observation-incomplete")).toBe("reconnect");
  });
  it("keeps incomplete observation when a diagnostic hides the package", () => {
    expect(read(observed({ packages: [], artifacts: [], diagnostics: [diagnostic("packages/tools")] }))).toMatchObject({
      status: "blocked",
      code: "source-observation-incomplete",
    });
  });
  it("ignores unrelated diagnostics while retaining exact folder checks", () => {
    expect(read(observed({ diagnostics: [diagnostic("packages/elsewhere/skills/other")] }))).toMatchObject({
      status: "ready",
    });
  });
  it("keeps incomplete observation when the source cannot be observed", () => {
    expect(read({ status: "corrupt", diagnostic: "Unreadable fixture.", recoveryAvailable: false })).toMatchObject({
      status: "blocked",
      code: "source-observation-incomplete",
    });
  });
});
