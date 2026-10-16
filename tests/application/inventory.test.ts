import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scanInventory, type InventoryScanDependencies } from "../../src/application/inventory";
import { createLocalInventoryPort } from "../../src/adapters/inventory/local-filesystem";
import type { InventoryDetector, InventoryDetectorResult } from "../../src/adapters/inventory/shared";
import { createResourceCatalogue, type ResourceSnapshot } from "../../src/domain/resource-catalogue";
import { InventoryFilesystemError, type InventoryFilesystemPort } from "../../src/ports/inventory";
import { parseInventorySnapshot } from "../../src/shared/inventory-dto";
import { projectCanvas } from "../../src/renderer/canvas/spatial/canvas-projection";
import { resourceFixture } from "../fixtures/resource-catalogue";

const filesystem = {
  async readBytes(path: string): Promise<Uint8Array> {
    throw new InventoryFilesystemError("readBytes", path, "not-found", "path does not exist");
  },
} as InventoryFilesystemPort;

function artifact(overrides: Record<string, unknown> = {}) {
  const physicalIdentity =
    typeof overrides.physicalIdentity === "string" ? overrides.physicalIdentity : "shared/skills/review/SKILL.md";
  return {
    id: `test-${physicalIdentity.replaceAll("/", "-")}`,
    kind: "skill" as const,
    relativePath: ".agents/skills/review/SKILL.md",
    displayPath: ".agents/skills/review/SKILL.md",
    physicalIdentity: "shared/skills/review/SKILL.md",
    projectionPaths: [".agents/skills/review/SKILL.md"],
    providerIds: ["codex"],
    scope: "project" as const,
    confidence: "exact" as const,
    symlinkState: "none" as const,
    providerState: {
      packageState: "unknown",
      activationState: "unknown",
      authenticationPolicy: "unknown",
      authenticationState: "unknown",
    } as const,
    ...overrides,
  };
}

function detector(
  providerId: string,
  result:
    | Omit<InventoryDetectorResult, "providerId">
    | ((scope: "project" | "source" | "user") => Promise<InventoryDetectorResult>),
): InventoryDetector {
  return {
    providerId,
    detect: async (_filesystem, scope = "project") =>
      typeof result === "function" ? result(scope) : { providerId, ...result },
  };
}

function gitDependencies(): InventoryScanDependencies {
  return {
    filesystem,
    git: {
      async collect() {
        return { scopes: [], diagnostics: [] };
      },
    },
  };
}

const request = {
  approvedRoot: "/private/selected-project",
  rootHandle: "grant-opaque-123",
  displayRoot: "selected-project",
  scope: "project" as const,
  observedAt: "2026-09-09T10:00:00.000Z",
};

describe("inventory application orchestration", () => {
  it("round-trips lock provenance into stable project groups without changing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-origin-scan-"));
    try {
      const folder = join(root, ".agents/skills/review");
      await mkdir(folder, { recursive: true });
      const skill = Buffer.from("# Review\n");
      const support = Buffer.from("one\n");
      await writeFile(join(folder, "SKILL.md"), skill);
      await writeFile(join(folder, "guide.md"), support);
      const hash = createHash("sha256")
        .update("guide.md", "utf8")
        .update(support)
        .update("SKILL.md", "utf8")
        .update(skill)
        .digest("hex");
      await writeFile(
        join(root, "skills-lock.json"),
        JSON.stringify({
          version: 1,
          skills: {
            review: { source: "owner/tools", sourceType: "github", computedHash: hash },
          },
        }),
      );
      const dependencies: InventoryScanDependencies = {
        filesystem: createLocalInventoryPort(root),
        detectors: [
          detector("claude-code", {
            artifacts: [
              artifact({
                physicalIdentity: ".agents/skills/review/SKILL.md",
                relativePath: ".agents/skills/review/SKILL.md",
                displayPath: ".agents/skills/review/SKILL.md",
                projectionPaths: [".agents/skills/review/SKILL.md"],
                providerIds: ["claude-code"],
              }),
            ],
            diagnostics: [],
          }),
        ],
        git: {
          async collect() {
            return { scopes: [], diagnostics: [] };
          },
        },
      };
      const scanRequest = { ...request, approvedRoot: root };
      const files = [join(folder, "SKILL.md"), join(folder, "guide.md"), join(root, "skills-lock.json")];
      const readFiles = async (): Promise<Buffer[]> => Promise.all(files.map((path) => readFile(path)));
      const bytesBefore = await readFiles();

      const first = await scanInventory(scanRequest, dependencies);
      const bytesAfterFirst = await readFiles();
      const repeated = await scanInventory(scanRequest, dependencies);

      const groupProjection = (inventory: typeof first) => {
        const parsedInventory = parseInventorySnapshot(JSON.parse(JSON.stringify(inventory)) as unknown);
        const entry = resourceFixture.projectOneRef;
        const snapshot: ResourceSnapshot = {
          registry: resourceFixture.registry,
          roots: [
            {
              entry,
              evidence: {
                status: "observed",
                observation: { subject: entry, observedAt: inventory.observedAt, inventory: parsedInventory },
              },
            },
          ],
          uses: { status: "ready", bindings: [] },
        };
        const catalogue = createResourceCatalogue(snapshot);
        const projection = projectCanvas(catalogue.browse({ kind: "entry", entry }), catalogue, null);
        return { groups: catalogue.projectSkillGroups(entry), projection };
      };
      const firstView = groupProjection(first);
      const repeatedView = groupProjection(repeated);

      expect(bytesAfterFirst).toEqual(bytesBefore);
      expect(await readFiles()).toEqual(bytesBefore);
      expect(repeated).toEqual(first);
      expect(firstView.groups.map((group) => group.id)).toEqual(repeatedView.groups.map((group) => group.id));
      expect(firstView.groups).toMatchObject([
        {
          id: JSON.stringify(["origin", "github", "owner/tools"]),
          category: "origin",
          locations: [{ relativePath: ".agents/skills/review/SKILL.md" }],
        },
      ]);
      expect(firstView.projection.groups[0]?.children.map((node) => node.id)).toEqual(
        repeatedView.projection.groups[0]?.children.map((node) => node.id),
      );
      await writeFile(join(folder, "guide.md"), "two\n");
      const refreshed = await scanInventory(scanRequest, dependencies);

      expect(first.skillOrigins).toMatchObject([{ verification: "matches-lock" }]);
      expect(refreshed.skillOrigins).toMatchObject([{ verification: "modified" }]);
      expect(refreshed.skillOrigins?.[0]?.artifactId).toBe(first.skillOrigins?.[0]?.artifactId);
      expect(first.diagnostics).toEqual([]);
      expect(refreshed.diagnostics).toEqual([]);

      await rm(join(root, "skills-lock.json"));
      const withoutLock = await scanInventory(scanRequest, dependencies);
      const fallbackView = groupProjection(withoutLock);
      expect(fallbackView.groups).toMatchObject([
        {
          id: "individual-skills",
          category: "individual",
          locations: [{ relativePath: ".agents/skills/review/SKILL.md" }],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves usable artifacts when one detector throws", async () => {
    const dependencies = gitDependencies();
    dependencies.detectors = [
      detector("zeta", {
        artifacts: [
          artifact({
            relativePath: "zeta.md",
            displayPath: "zeta.md",
            physicalIdentity: "zeta.md",
            providerIds: ["zeta"],
          }),
        ],
        diagnostics: [],
      }),
      detector("broken", async () => {
        throw new Error("/private/selected-project detector body secret");
      }),
      detector("alpha", {
        artifacts: [
          artifact({
            relativePath: "alpha.md",
            displayPath: "alpha.md",
            physicalIdentity: "alpha.md",
            providerIds: ["alpha"],
          }),
        ],
        diagnostics: [],
      }),
    ];

    const snapshot = await scanInventory(request, dependencies);

    expect(snapshot.artifacts.map((item) => item.relativePath)).toEqual(["alpha.md", "zeta.md"]);
    expect(snapshot.harnesses).toEqual(["alpha", "zeta"]);
    expect(snapshot.diagnostics).toEqual([expect.objectContaining({ code: "inaccessible", location: "broken" })]);
    expect(JSON.stringify(snapshot)).not.toContain("/private/selected-project");
    expect(JSON.stringify(snapshot)).not.toContain("detector body secret");
  });

  it("orders repeated scans deterministically and merges duplicate physical projections", async () => {
    const dependencies = gitDependencies();
    dependencies.detectors = [
      detector("cursor", {
        artifacts: [
          artifact({
            relativePath: ".cursor/skills/review/SKILL.md",
            displayPath: ".cursor/skills/review/SKILL.md",
            projectionPaths: [".cursor/skills/review/SKILL.md"],
            providerIds: ["cursor"],
          }),
        ],
        diagnostics: [],
      }),
      detector("codex", {
        artifacts: [artifact()],
        diagnostics: [],
      }),
    ];

    const first = await scanInventory(request, dependencies);
    dependencies.detectors = [...dependencies.detectors].reverse();
    const second = await scanInventory(request, dependencies);

    expect(first).toEqual(second);
    expect(first.artifacts).toHaveLength(1);
    expect(first.artifacts[0]).toMatchObject({
      providerIds: ["codex", "cursor"],
      projectionPaths: [".agents/skills/review/SKILL.md", ".cursor/skills/review/SKILL.md"],
      relativePath: ".agents/skills/review/SKILL.md",
    });
  });

  it("uses the observation scope before computing stable artifact identities", async () => {
    const dependencies = gitDependencies();
    dependencies.detectors = [
      detector("codex", async (scope) => ({
        providerId: "codex",
        artifacts: [artifact({ id: undefined, scope })],
        diagnostics: [],
      })),
    ];

    const projectSnapshot = await scanInventory(request, dependencies);
    const sourceSnapshot = await scanInventory(
      { ...request, displayRoot: "marketplace", scope: "source" },
      dependencies,
    );

    expect(projectSnapshot.artifacts[0]).toMatchObject({ scope: "project" });
    expect(sourceSnapshot.artifacts[0]).toMatchObject({ scope: "source" });
    expect(sourceSnapshot.artifacts[0]?.id).not.toBe(projectSnapshot.artifacts[0]?.id);
  });

  it("carries harness-agnostic package identity into a source snapshot", async () => {
    const packageArtifact = artifact({
      id: undefined,
      providerIds: [],
      scope: "source",
      relativePath: "community/skills/review/SKILL.md",
      displayPath: "community/skills/review/SKILL.md",
      physicalIdentity: "community/skills/review/SKILL.md",
      packageId: "community",
    });
    const snapshot = await scanInventory(
      { ...request, scope: "source" },
      {
        ...gitDependencies(),
        detectors: [
          {
            providerId: "source-layout",
            harnessAgnostic: true,
            detect: async () => ({
              providerId: "source-layout",
              artifacts: [packageArtifact],
              packages: [
                {
                  id: "community",
                  relativeRoot: "community",
                  displayName: "Community",
                  format: "cursor-plugin",
                  manifestPaths: ["community/.cursor-plugin/plugin.json"],
                  artifactIds: [],
                },
              ],
              diagnostics: [],
            }),
          },
        ],
      },
    );

    expect(snapshot.harnesses).toEqual([]);
    expect(snapshot.artifacts[0]).toMatchObject({ packageId: "community", providerIds: [] });
    expect(snapshot.packages).toEqual([
      expect.objectContaining({ id: "community", artifactIds: [snapshot.artifacts[0]?.id] }),
    ]);
  });

  it("rebinds untrusted detector scope and identity to the scan request", async () => {
    const dependencies = gitDependencies();
    dependencies.detectors = [
      detector("untrusted", {
        artifacts: [artifact({ id: "attacker-id", scope: "provider-cache", providerIds: ["cursor"] })],
        diagnostics: [],
      }),
    ];

    const snapshot = await scanInventory(request, dependencies);

    expect(snapshot.artifacts[0]).toMatchObject({ scope: "project", providerIds: ["untrusted"] });
    expect(snapshot.artifacts[0]?.id).not.toBe("attacker-id");
  });

  it("retains valid partial diagnostics while dropping malformed detector records safely", async () => {
    const dependencies = gitDependencies();
    dependencies.detectors = [
      detector("partial", async () => ({
        providerId: "partial",
        artifacts: [
          artifact({
            relativePath: "valid.md",
            displayPath: "valid.md",
            physicalIdentity: "valid.md",
            providerIds: ["partial"],
          }),
          { relativePath: "/private/selected-project/raw-frontmatter.md", content: "---\nsecret: value\n---" },
        ] as never,
        diagnostics: [
          {
            location: "partial/known-location",
            code: "malformed",
            severity: "warning",
            message: "The documented metadata is malformed.",
          },
          {
            location: "/private/selected-project/private",
            code: "malformed",
            severity: "warning",
            message: "raw frontmatter secret=value",
          },
        ] as never,
      })),
    ];

    const snapshot = await scanInventory(request, dependencies);

    expect(snapshot.artifacts.map((item) => item.relativePath)).toEqual(["valid.md"]);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ location: "partial/known-location", code: "malformed" }),
      expect.objectContaining({ location: "partial", code: "malformed" }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("/private/selected-project");
    expect(JSON.stringify(snapshot)).not.toContain("raw-frontmatter");
    expect(JSON.stringify(snapshot)).not.toContain("secret=value");
  });

  it("validates the composed snapshot through the domain constructor and never exposes bodies or absolute paths", async () => {
    const dependencies = gitDependencies();
    dependencies.detectors = [
      detector("safe", {
        artifacts: [
          artifact({
            relativePath: "safe.md",
            displayPath: "safe.md",
            physicalIdentity: "safe.md",
            providerIds: ["safe"],
            content: "must not be returned",
            frontmatter: { secret: "must not be returned" },
          }),
        ],
        diagnostics: [],
      }),
    ];

    const snapshot = await scanInventory(request, dependencies);

    expect(snapshot.rootHandle).toBe("grant-opaque-123");
    expect(snapshot.displayRoot).toBe("selected-project");
    expect(JSON.stringify(snapshot)).not.toContain("content");
    expect(JSON.stringify(snapshot)).not.toContain("must not be returned");
    expect(JSON.stringify(snapshot)).not.toContain("/private/selected-project");
  });

  it("does not preserve untrusted provider state conclusions or revision secrets", async () => {
    const dependencies = gitDependencies();
    dependencies.detectors = [
      detector("untrusted", {
        artifacts: [
          artifact({
            relativePath: "untrusted.md",
            displayPath: "untrusted.md",
            physicalIdentity: "untrusted.md",
            providerIds: ["untrusted"],
            providerState: {
              packageState: "current",
              activationState: "active",
              authenticationPolicy: "on-use",
              authenticationState: "authenticated",
              revision: "/private/selected-project/.cache/secret-token",
            },
          }),
        ],
        diagnostics: [],
      }),
    ];

    const snapshot = await scanInventory(request, dependencies);

    expect(snapshot.artifacts[0].providerState).toEqual({
      packageState: "unknown",
      activationState: "unknown",
      authenticationPolicy: "unknown",
      authenticationState: "unknown",
    });
    expect(JSON.stringify(snapshot)).not.toContain("/private/selected-project");
    expect(JSON.stringify(snapshot)).not.toContain("secret-token");
    expect(JSON.stringify(snapshot)).not.toContain("current");
    expect(JSON.stringify(snapshot)).not.toContain("authenticated");
  });

  it("redacts quoted absolute paths with spaces and UNC paths in detector diagnostics", async () => {
    const dependencies = gitDependencies();
    dependencies.detectors = [
      detector("leaky", {
        artifacts: [],
        diagnostics: [
          {
            location: "leaky/location",
            code: "inaccessible",
            severity: "warning",
            message: 'Could not read "/Users/example/My Project/private.txt" or "\\\\server\\share\\private.txt".',
          },
        ],
      }),
    ];

    const snapshot = await scanInventory(request, dependencies);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ location: "leaky/location", code: "inaccessible" }),
    ]);
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("My Project");
    expect(serialized).not.toContain("server");
    expect(serialized).not.toContain("share");
  });
});
