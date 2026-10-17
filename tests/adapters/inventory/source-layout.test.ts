import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detectSourceLayout } from "../../../src/adapters/inventory/source-layout";
import { createLocalInventoryPort } from "../../../src/adapters/inventory/local-filesystem";

const temporaryRoots: string[] = [];
const portableSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

async function writeFixtureFile(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-source-layout-"));
  temporaryRoots.push(root);
  await writeFixtureFile(root, "omni.marketplace.json", JSON.stringify({ packages: [{ path: "plugins/declared" }] }));
  await writeFixtureFile(
    root,
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      plugins: [{ source: "./community" }],
    }),
  );
  await writeFixtureFile(root, "plugins/declared/.claude-plugin/plugin.json", '{"name":"declared"}');
  await writeFixtureFile(root, "plugins/declared/.codex-plugin/plugin.json", '{"name":"declared-codex"}');
  await writeFixtureFile(root, "plugins/declared/skills/review/SKILL.md", "---\nname: review\n---\n");
  await writeFixtureFile(root, "plugins/declared/commands/check.md", "# Check\n");
  await writeFixtureFile(root, "plugins/declared/agents/reviewer.md", "# Reviewer\n");
  await writeFixtureFile(root, "plugins/declared/hooks/on-save.sh", "#!/bin/sh\n");
  await writeFixtureFile(root, "plugins/declared/mcp/local.json", "{}\n");
  await writeFixtureFile(root, "plugins/declared/instructions/usage.md", "Use it.\n");
  await writeFixtureFile(root, "community/.cursor-plugin/plugin.json", '{"name":"community"}');
  await writeFixtureFile(root, "community/skills/other/SKILL.md", "---\nname: other\n---\n");
  await writeFixtureFile(root, "implicit/skills/loose/SKILL.md", "---\nname: loose\n---\n");
  await writeFixtureFile(root, "broken/.claude-plugin/plugin.json", '{"name":');
  await writeFixtureFile(root, "skills/root/SKILL.md", "---\nname: root\n---\n");
  await writeFixtureFile(root, ".git/ignored.txt", "not an artifact\n");
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("source layout detector", () => {
  it("recognizes a portable root plugin and keeps identity rooted in its observed path", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-plugin-root-"));
    temporaryRoots.push(root);
    await writeFixtureFile(
      root,
      "plugin.json",
      JSON.stringify({
        $schema: portableSchema,
        name: "Agent Skills",
        skills: ["./skills"],
      }),
    );
    await writeFixtureFile(root, "skills/review/SKILL.md", "---\nname: review\n---\n");

    const result = await detectSourceLayout(createLocalInventoryPort(root), "project");

    expect(result.packages).toMatchObject([
      {
        id: "root",
        relativeRoot: "root",
        displayName: "Agent Skills",
        format: "agent-plugin",
        manifestPaths: ["plugin.json"],
      },
    ]);
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "plugin.json", kind: "plugin-manifest", packageId: "root" }),
        expect.objectContaining({ relativePath: "skills/review/SKILL.md", kind: "skill", packageId: "root" }),
      ]),
    );
  });

  it("prefers portable identity over Codex compatibility while retaining Omni priority", async () => {
    const portableRoot = await mkdtemp(join(tmpdir(), "omni-agent-plugin-codex-"));
    const omniRoot = await mkdtemp(join(tmpdir(), "omni-agent-plugin-omni-"));
    temporaryRoots.push(portableRoot, omniRoot);
    await writeFixtureFile(portableRoot, "plugin.json", JSON.stringify({ $schema: portableSchema, name: "Portable" }));
    await writeFixtureFile(portableRoot, ".codex-plugin/plugin.json", JSON.stringify({ name: "Codex fallback" }));
    await writeFixtureFile(omniRoot, "plugin.json", JSON.stringify({ $schema: portableSchema, name: "Portable" }));
    await writeFixtureFile(omniRoot, "omni.plugin.json", JSON.stringify({ name: "Omni" }));

    const portable = await detectSourceLayout(createLocalInventoryPort(portableRoot), "project");
    const omni = await detectSourceLayout(createLocalInventoryPort(omniRoot), "project");

    expect(portable.packages?.[0]).toMatchObject({ format: "agent-plugin", displayName: "Portable" });
    expect(omni.packages?.[0]).toMatchObject({ format: "omni", displayName: "Omni" });
  });

  it("keeps unsupported portable formats visible without claiming package membership", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-plugin-unsupported-"));
    temporaryRoots.push(root);
    await writeFixtureFile(
      root,
      "plugin.json",
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
        name: "Unsupported",
      }),
    );
    await writeFixtureFile(root, "skills/review/SKILL.md", "---\nname: review\n---\n");

    const result = await detectSourceLayout(createLocalInventoryPort(root), "project");

    expect(result.packages ?? []).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.diagnostics).toMatchObject([{ code: "unsupported", location: "plugin.json" }]);
  });

  it("reports unsupported declared skill paths while scanning the default skills folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-plugin-paths-"));
    temporaryRoots.push(root);
    await writeFixtureFile(
      root,
      "plugin.json",
      JSON.stringify({
        $schema: portableSchema,
        name: "Agent Skills",
        skills: ["./custom-skills"],
      }),
    );
    await writeFixtureFile(root, "skills/review/SKILL.md", "---\nname: review\n---\n");

    const result = await detectSourceLayout(createLocalInventoryPort(root), "project");

    expect(result.packages?.[0]).toMatchObject({ format: "agent-plugin" });
    expect(result.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ relativePath: "skills/review/SKILL.md", packageId: "root" })]),
    );
    expect(result.diagnostics).toMatchObject([{ code: "unsupported", location: "plugin.json" }]);
  });

  it("recognizes a portable package below a registered source root", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-agent-plugin-source-"));
    temporaryRoots.push(root);
    await writeFixtureFile(
      root,
      "plugins/tools/plugin.json",
      JSON.stringify({ $schema: portableSchema, name: "Tools" }),
    );
    await writeFixtureFile(root, "plugins/tools/skills/review/SKILL.md", "---\nname: review\n---\n");

    const result = await detectSourceLayout(createLocalInventoryPort(root), "source");

    expect(result.packages).toMatchObject([{ id: "plugins/tools", format: "agent-plugin", displayName: "Tools" }]);
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        relativePath: "plugins/tools/skills/review/SKILL.md",
        packageId: "plugins/tools",
      }),
    );
  });

  it("observes a freshly created Omni marketplace as one empty package", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-source-layout-empty-"));
    temporaryRoots.push(root);
    await writeFixtureFile(
      root,
      "omni.marketplace.json",
      JSON.stringify({
        format: "omni.marketplace/1",
        id: "my-marketplace",
        name: "My Marketplace",
        createdAt: "2026-09-12T12:00:00.000Z",
        packages: [{ path: "packages/my-marketplace" }],
        createdBy: "omni/0.1.0",
      }),
    );
    await writeFixtureFile(
      root,
      "packages/my-marketplace/omni.plugin.json",
      JSON.stringify({
        format: "omni.plugin/1",
        id: "my-marketplace",
        name: "My Marketplace",
        version: "0.1.0",
        artifacts: [],
      }),
    );

    const result = await detectSourceLayout(createLocalInventoryPort(root), "source");

    expect(result.packages).toHaveLength(1);
    expect(result.packages?.[0]).toMatchObject({ relativeRoot: "packages/my-marketplace", format: "omni" });
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "omni.marketplace.json", kind: "marketplace-manifest" }),
        expect.objectContaining({
          relativePath: "packages/my-marketplace/omni.plugin.json",
          kind: "plugin-manifest",
          packageId: "packages/my-marketplace",
        }),
      ]),
    );
    expect(result.artifacts.filter((artifact) => artifact.packageId === "packages/my-marketplace")).toHaveLength(1);
    expect(
      result.artifacts.filter(
        (artifact) => artifact.kind !== "marketplace-manifest" && artifact.kind !== "plugin-manifest",
      ),
    ).toHaveLength(0);
  });

  it("discovers declared, undeclared, implicit, and loose source evidence", async () => {
    const root = await createFixture();

    const result = await detectSourceLayout(createLocalInventoryPort(root), "source");

    expect(
      result.packages?.map((pkg) => ({
        id: pkg.id,
        relativeRoot: pkg.relativeRoot,
        format: pkg.format,
        declaredBy: pkg.declaredBy,
      })),
    ).toEqual([
      { id: "broken", relativeRoot: "broken", format: "claude-plugin", declaredBy: undefined },
      { id: "community", relativeRoot: "community", format: "cursor-plugin", declaredBy: "marketplace-manifest" },
      { id: "implicit", relativeRoot: "implicit", format: "implicit", declaredBy: undefined },
      {
        id: "plugins/declared",
        relativeRoot: "plugins/declared",
        format: "claude-plugin",
        declaredBy: "marketplace-manifest",
      },
    ]);
    expect(
      result.artifacts
        .filter((artifact) => artifact.packageId)
        .map((artifact) => [artifact.relativePath, artifact.packageId]),
    ).toEqual([
      ["broken/.claude-plugin/plugin.json", "broken"],
      ["community/.cursor-plugin/plugin.json", "community"],
      ["community/skills/other/SKILL.md", "community"],
      ["implicit/skills/loose/SKILL.md", "implicit"],
      ["plugins/declared/.claude-plugin/plugin.json", "plugins/declared"],
      ["plugins/declared/.codex-plugin/plugin.json", "plugins/declared"],
      ["plugins/declared/agents/reviewer.md", "plugins/declared"],
      ["plugins/declared/commands/check.md", "plugins/declared"],
      ["plugins/declared/hooks/on-save.sh", "plugins/declared"],
      ["plugins/declared/instructions/usage.md", "plugins/declared"],
      ["plugins/declared/mcp/local.json", "plugins/declared"],
      ["plugins/declared/skills/review/SKILL.md", "plugins/declared"],
    ]);
    expect(
      result.artifacts.some((artifact) => artifact.relativePath === "skills/root/SKILL.md" && !artifact.packageId),
    ).toBe(true);
    expect(
      result.artifacts.some(
        (artifact) => artifact.relativePath === "omni.marketplace.json" && artifact.kind === "marketplace-manifest",
      ),
    ).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.relativePath === ".git/ignored.txt")).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ location: "broken/.claude-plugin/plugin.json", code: "malformed" }),
        expect.objectContaining({ location: "implicit", severity: "info" }),
      ]),
    );
  });

  it("does not scan source package directories during project observation", async () => {
    const root = await createFixture();

    const result = await detectSourceLayout(createLocalInventoryPort(root), "project");
    expect(result.artifacts).toEqual([]);
    expect(result.packages).toBeUndefined();
  });

  it("keeps remote marketplace declarations separate from observed packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-remote-declarations-"));
    temporaryRoots.push(root);
    await writeFixtureFile(
      root,
      "marketplace.json",
      JSON.stringify({
        name: "Community catalog",
        plugins: [
          { path: "plugins/local", description: "Local plugin" },
          {
            source: { source: "github", repo: "owner/remote", ref: "v2" },
            name: "Remote Plugin",
            description: "Remote description",
            version: "2.0.0",
          },
          { source: "github:owner/string-remote" },
        ],
      }),
    );
    await writeFixtureFile(root, "plugins/local/.claude-plugin/plugin.json", JSON.stringify({ name: "Local Plugin" }));

    const result = await detectSourceLayout(createLocalInventoryPort(root), "source");

    expect(result.packages).toEqual([
      expect.objectContaining({ relativeRoot: "plugins/local", description: "Local plugin" }),
    ]);
    expect(result.marketplace?.remotePackages).toEqual([
      { name: "Remote Plugin", description: "Remote description", version: "2.0.0", locator: "github:owner/remote@v2" },
      { name: "string-remote", locator: "github:owner/string-remote" },
    ]);
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "malformed", location: "marketplace.json" })]),
    );
  });
});
