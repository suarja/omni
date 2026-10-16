import { expect, it } from "vitest";
import { createPackageManifest, parsePackageManifest } from "../../src/domain/marketplace-format";

const provenance = {
  source: "mattpocock/skills",
  ref: "main",
  skillPath: "skills/grill-me",
  computedHash: "a".repeat(64),
  contentHash: "b".repeat(64),
  relativePath: ".claude/skills/grill-me",
  project: { id: "project-alpha", name: "alpha" },
  importedAt: "2026-10-12T00:00:00.000Z",
};

it("round trips distinct structured origins per artifact alongside legacy plugin provenance", () => {
  const legacy = {
    importedFrom: {
      sourceName: "Legacy plugin",
      relativePath: "plugins/design",
      contentHash: "c".repeat(64),
      importedAt: "2026-10-11T00:00:00.000Z",
    },
    reason: "Keep the plugin's history.",
  };
  const manifest = createPackageManifest({
    id: "design",
    name: "design",
    provenance: legacy,
    artifacts: [
      { kind: "skill", path: "skills/grill-me", provenance },
      {
        kind: "skill",
        path: "skills/local-tool",
        provenance: { ...provenance, source: "alpha", skillPath: ".claude/skills/local-tool" },
      },
    ],
  });
  expect(parsePackageManifest(manifest)).toEqual(manifest);
  expect(manifest.provenance).toEqual(legacy);
  expect(manifest.artifacts.map((artifact) => artifact.provenance?.source)).toEqual(["mattpocock/skills", "alpha"]);
});

it.each([
  { skillPath: "../outside" },
  { relativePath: "/outside" },
  { computedHash: "invalid" },
  { importedAt: "today" },
  { project: { id: "../alpha", name: "alpha" } },
  { extra: true },
])("rejects unsafe or malformed artifact origin fields: %j", (invalid) => {
  expect(() =>
    parsePackageManifest({
      format: "omni.plugin/1",
      id: "design",
      name: "design",
      version: "0.1.0",
      artifacts: [{ kind: "skill", path: "skills/grill-me", provenance: { ...provenance, ...invalid } }],
    }),
  ).toThrow();
});
