import { describe, expect, it } from "vitest";

import { parseInventorySnapshot } from "../../src/shared/inventory-dto";

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "observed",
    observation: {
      subject: { kind: "source", id: "source-one" },
      observedAt: "2026-09-13T10:00:00.000Z",
      inventory: {
        rootHandle: "grant-one",
        displayRoot: "source",
        observedAt: "2026-09-13T10:00:00.000Z",
        harnesses: [],
        artifacts: [
          {
            id: "artifact-one",
            physicalIdentity: "skills/review/SKILL.md",
            projectionPaths: ["skills/review/SKILL.md"],
            kind: "skill",
            relativePath: "skills/review/SKILL.md",
            displayPath: "skills/review/SKILL.md",
            providerIds: [],
            scope: "source",
            confidence: "exact",
            symlinkState: "none",
            summary: "Review reusable changes",
          },
        ],
        packages: [
          {
            id: "packages/review",
            relativeRoot: "packages/review",
            displayName: "Review",
            format: "omni",
            manifestPaths: ["packages/review/omni.plugin.json"],
            artifactIds: ["artifact-one"],
            description: "Review package",
            version: "1.2.3",
            readmePath: "packages/review/README.md",
          },
        ],
        marketplace: {
          name: "Local catalogue",
          description: "A local marketplace",
          readmePath: "README.md",
          manifestPath: "omni.marketplace.json",
          remotePackages: [{ name: "Remote review", version: "2.0.0", locator: "github:owner/review@v2" }],
        },
        diagnostics: [],
        gitScopes: [],
      },
    },
    ...overrides,
  };
}

function inventoryFromResponse(value: Record<string, unknown>): Record<string, unknown> {
  return (value.observation as Record<string, unknown>).inventory as Record<string, unknown>;
}

describe("inventory snapshot IPC boundary", () => {
  it("accepts observed branches and rejects paths or control characters as branch labels", () => {
    const snapshot = inventoryFromResponse(response());
    const scope = {
      id: "git-project",
      relativeRoot: "project",
      head: "a".repeat(40),
      branch: "feature/project-view",
      dirty: true,
    };
    expect(parseInventorySnapshot({ ...snapshot, gitScopes: [scope] }).gitScopes[0].branch).toBe(
      "feature/project-view",
    );
    for (const branch of ["/private/project", "../project", "main\nsecret", "main\0"])
      expect(() => parseInventorySnapshot({ ...snapshot, gitScopes: [{ ...scope, branch }] })).toThrow(/branch/i);
  });
  it("round-trips observed descriptions and relative README metadata", () => {
    const snapshot = inventoryFromResponse(response());
    const parsed = parseInventorySnapshot(JSON.parse(JSON.stringify(snapshot)));

    expect(parsed).toEqual(snapshot);
  });

  it("keeps legacy observations valid and validates additive origin references", () => {
    const legacy = inventoryFromResponse(response());
    expect(parseInventorySnapshot(legacy)).not.toHaveProperty("skillOrigins");

    const withOrigin = structuredClone(legacy);
    (withOrigin.artifacts as Record<string, unknown>[])[0]!.scope = "project";
    (withOrigin.artifacts as Record<string, unknown>[])[0]!.relativePath = ".agents/skills/review/SKILL.md";
    (withOrigin.artifacts as Record<string, unknown>[])[0]!.projectionPaths = [".agents/skills/review/SKILL.md"];
    withOrigin.skillOrigins = [
      {
        artifactId: "artifact-one",
        relativePath: ".agents/skills/review/SKILL.md",
        source: { kind: "github", locator: "owner/tools" },
        lockPath: "skills-lock.json",
        recordedHash: "a".repeat(64),
        verification: "unverified",
        verificationReason: "unavailable",
      },
    ];
    expect(parseInventorySnapshot(withOrigin).skillOrigins).toMatchObject([
      { relativePath: ".agents/skills/review/SKILL.md" },
    ]);

    withOrigin.skillOrigins = [
      {
        ...(withOrigin.skillOrigins as Record<string, unknown>[])[0],
        absoluteRoot: "/private/project",
      },
    ];
    expect(() => parseInventorySnapshot(withOrigin)).toThrow();
  });

  it("rejects non-string observed descriptions and paths", () => {
    const invalidValues = [
      ["marketplace", "description", 42],
      ["package", "version", false],
      ["artifact", "summary", { value: "not a string" }],
      ["package", "readmePath", "/private/readme.md"],
    ] as const;

    for (const [kind, field, value] of invalidValues) {
      const invalid = response();
      const inventory = (invalid.observation as Record<string, unknown>).inventory as Record<string, unknown>;
      if (kind === "marketplace") {
        inventory.marketplace = { ...(inventory.marketplace as Record<string, unknown>), [field]: value };
      } else if (kind === "package") {
        inventory.packages = [{ ...(inventory.packages as Record<string, unknown>[])[0], [field]: value }];
      } else {
        inventory.artifacts = [{ ...(inventory.artifacts as Record<string, unknown>[])[0], [field]: value }];
      }
      expect(() => parseInventorySnapshot(inventoryFromResponse(invalid))).toThrow();
    }
  });

  it("rejects unsafe summary and marketplace shapes", () => {
    const invalidSummary = inventoryFromResponse(response());
    invalidSummary.artifacts = [
      {
        ...(invalidSummary.artifacts as Record<string, unknown>[])[0],
        summary: `${"x".repeat(240)}\nextra line`,
      },
    ];
    expect(() => parseInventorySnapshot(invalidSummary)).toThrow();

    const invalidMarketplace = inventoryFromResponse(response());
    invalidMarketplace.marketplace = {
      ...(invalidMarketplace.marketplace as Record<string, unknown>),
      unexpected: true,
    };
    expect(() => parseInventorySnapshot(invalidMarketplace)).toThrow();
  });

  it("rejects unsafe remote package declarations", () => {
    const invalidControl = inventoryFromResponse(response());
    (invalidControl.marketplace as Record<string, unknown>).remotePackages = [
      {
        name: "Remote",
        locator: "github:owner/review\u0000",
      },
    ];
    expect(() => parseInventorySnapshot(invalidControl)).toThrow();

    const invalidLength = inventoryFromResponse(response());
    (invalidLength.marketplace as Record<string, unknown>).remotePackages = [
      {
        name: "Remote",
        locator: "x".repeat(201),
      },
    ];
    expect(() => parseInventorySnapshot(invalidLength)).toThrow();

    const invalidKeys = inventoryFromResponse(response());
    (invalidKeys.marketplace as Record<string, unknown>).remotePackages = [
      {
        name: "Remote",
        locator: "github:owner/review",
        unexpected: true,
      },
    ];
    expect(() => parseInventorySnapshot(invalidKeys)).toThrow();
  });
});
