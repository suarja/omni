import { describe, expect, it } from "vitest";

import {
  createMarketplaceManifest,
  createPackageManifest,
  parseMarketplaceManifest,
  parsePackageManifest,
  slugify,
} from "../../src/domain/marketplace-format";

describe("Omni marketplace format", () => {
  it("creates a marketplace with one empty package destination", () => {
    expect(
      createMarketplaceManifest({
        name: "My Tools",
        createdAt: "2026-09-12T12:00:00.000Z",
        createdBy: "omni/0.1.0",
      }),
    ).toEqual({
      format: "omni.marketplace/1",
      id: "my-tools",
      name: "My Tools",
      createdAt: "2026-09-12T12:00:00.000Z",
      packages: [{ path: "packages/my-tools" }],
      createdBy: "omni/0.1.0",
    });
  });

  it("creates and parses an empty package manifest", () => {
    const manifest = createPackageManifest({ id: "my-tools", name: "My Tools" });
    expect(manifest).toEqual({
      format: "omni.plugin/1",
      id: "my-tools",
      name: "My Tools",
      version: "0.1.0",
      artifacts: [],
    });
    expect(parsePackageManifest(manifest)).toEqual(manifest);
  });

  it("rejects unknown keys, formats, and escaping paths", () => {
    const marketplace = createMarketplaceManifest({ name: "Tools", createdAt: "2026-09-12T12:00:00.000Z" });
    expect(() => parseMarketplaceManifest({ ...marketplace, extra: true })).toThrow(/unexpected field/i);
    expect(() => parseMarketplaceManifest({ ...marketplace, format: "other/1" })).toThrow(/format/i);
    expect(() => parseMarketplaceManifest({ ...marketplace, packages: [{ path: "../outside" }] })).toThrow(/path/i);
    expect(() =>
      parsePackageManifest({
        ...createPackageManifest({ id: "tools", name: "Tools" }),
        artifacts: [{ kind: "skill", path: "/tmp/escape" }],
      }),
    ).toThrow(/path/i);
  });
  it("preserves an optional local visibility declaration and rejects unsupported values", () => {
    const marketplace = createMarketplaceManifest({ name: "Tools", createdAt: "2026-09-12T12:00:00.000Z" });
    for (const visibility of ["private", "public"] as const)
      expect(parseMarketplaceManifest({ ...marketplace, visibility })).toEqual({ ...marketplace, visibility });
    expect(() => parseMarketplaceManifest({ ...marketplace, visibility: "unknown" })).toThrow(/visibility/i);
  });

  it("round trips distinct per-skill origins without using package provenance", () => {
    const firstOrigin = {
      schemaVersion: 1 as const,
      variantId: "123e4567-e89b-42d3-a456-426614174000",
      forkOf: "123e4567-e89b-42d3-a456-426614174001",
      capturedAt: "2026-10-09T07:00:00.000Z",
      capturedFrom: {
        location: { projectId: "project-a", harnessId: "codex" as const, folderPath: ".agents/skills/demo" },
        revision: { algorithm: "omni-tree-v1" as const, hash: "a".repeat(64), files: [] },
      },
    };
    const secondOrigin = { ...firstOrigin, variantId: "123e4567-e89b-42d3-a456-426614174002" };
    const manifest = createPackageManifest({
      id: "tools",
      name: "Tools",
      provenance: { reason: "Existing package provenance" },
      artifacts: [
        { kind: "skill", path: "skills/demo-one", variantOrigin: firstOrigin },
        { kind: "skill", path: "skills/demo-two", variantOrigin: secondOrigin },
        { kind: "command", path: "commands/run" },
      ],
    });
    expect(parsePackageManifest(manifest).artifacts.map((artifact) => artifact.variantOrigin?.variantId)).toEqual([
      firstOrigin.variantId,
      secondOrigin.variantId,
      undefined,
    ]);
    expect(manifest.provenance).toEqual({ reason: "Existing package provenance" });
    expect(() =>
      parsePackageManifest({
        ...manifest,
        artifacts: [{ kind: "command", path: "commands/run", variantOrigin: firstOrigin }],
      }),
    ).toThrow(/only skill artifacts/i);
  });

  it("normalizes names to bounded lowercase slugs", () => {
    expect(slugify("  Café / My Tools! ")).toBe("cafe-my-tools");
    expect(slugify("---")).toBe("");
    expect(slugify("A".repeat(80))).toHaveLength(64);
    expect(slugify("a".repeat(80))).toMatch(/^[a-z0-9-]{1,64}$/);
  });
});
