import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detectClaudeCode } from "../../../src/adapters/inventory/claude-code";
import { createLocalInventoryPort } from "../../../src/adapters/inventory/local-filesystem";
import { detectSourceLayout } from "../../../src/adapters/inventory/source-layout";

const temporaryRoots: string[] = [];

async function writeFixtureFile(root: string, relativePath: string, content: string): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("observed descriptions", () => {
  it("observes marketplace and package metadata with safe relative README paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-observed-descriptions-"));
    temporaryRoots.push(root);
    await writeFixtureFile(root, "README.md", "Marketplace introduction\n");
    await writeFixtureFile(root, "readme.md", "Lowercase fallback\n");
    await writeFixtureFile(
      root,
      "omni.marketplace.json",
      JSON.stringify({
        name: "Local catalogue",
        visibility: "public",
        description: "A local marketplace",
        packages: [
          { path: "packages/featured", description: "Featured plugin", version: "2.0.0" },
          { path: "packages/empty" },
        ],
      }),
    );
    await writeFixtureFile(
      root,
      "packages/featured/omni.plugin.json",
      JSON.stringify({
        name: "Featured",
        description: "Manifest description",
        version: "1.0.0",
      }),
    );
    await writeFixtureFile(root, "packages/featured/README.md", "Featured README\n");
    await writeFixtureFile(root, "packages/empty/omni.plugin.json", JSON.stringify({ name: "Empty" }));
    await writeFixtureFile(
      root,
      "fallback/.claude-plugin/plugin.json",
      JSON.stringify({
        name: "Fallback",
        description: "Manifest fallback",
        version: "3.0.0",
      }),
    );
    await writeFixtureFile(root, "fallback/README.md", "Fallback README\n");

    const result = await detectSourceLayout(createLocalInventoryPort(root), "source");

    expect(result.marketplace).toEqual({
      name: "Local catalogue",
      visibility: "public",
      description: "A local marketplace",
      readmePath: "README.md",
      manifestPath: "omni.marketplace.json",
    });
    expect(result.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativeRoot: "packages/featured",
          description: "Featured plugin",
          version: "2.0.0",
          readmePath: "packages/featured/README.md",
        }),
        expect.objectContaining({
          relativeRoot: "fallback",
          description: "Manifest fallback",
          version: "3.0.0",
          readmePath: "fallback/README.md",
        }),
      ]),
    );
    const empty = result.packages?.find((pkg) => pkg.relativeRoot === "packages/empty");
    expect(empty).toBeDefined();
    expect(empty).not.toHaveProperty("description");
    expect(empty).not.toHaveProperty("version");
    expect(empty).not.toHaveProperty("readmePath");
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("observes skill and command summaries without changing malformed skill diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-artifact-descriptions-"));
    temporaryRoots.push(root);
    await writeFixtureFile(
      root,
      ".claude/skills/review/SKILL.md",
      "---\nname: review\ndescription: Skill summary\n---\n",
    );
    await writeFixtureFile(root, ".claude/commands/check.md", "---\ndescription: Command summary\n---\n# Check\n");
    await writeFixtureFile(root, ".claude/commands/long.md", `---\ndescription: ${"x".repeat(300)}\n---\n`);
    await writeFixtureFile(root, ".claude/agents/reviewer.md", "# Reviewer\n");
    await writeFixtureFile(
      root,
      ".claude/skills/broken/SKILL.md",
      "---\ndescription: Hidden summary\nnot valid\n---\n",
    );
    await writeFixtureFile(
      root,
      ".claude/skills/folded/SKILL.md",
      "---\nname: folded\ndescription: >-\n  Folded first line: with colon\n  second line\nallowed-tools: Bash\n---\n",
    );
    await writeFixtureFile(
      root,
      ".claude/skills/quoted/SKILL.md",
      '---\nname: quoted\ndescription: "Quoted summary"\n---\n',
    );

    const result = await detectClaudeCode(createLocalInventoryPort(root));

    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: ".claude/skills/review/SKILL.md", summary: "Skill summary" }),
        expect.objectContaining({ relativePath: ".claude/commands/check.md", summary: "Command summary" }),
        expect.objectContaining({
          relativePath: ".claude/skills/folded/SKILL.md",
          summary: "Folded first line: with colon",
        }),
        expect.objectContaining({ relativePath: ".claude/skills/quoted/SKILL.md", summary: "Quoted summary" }),
      ]),
    );
    expect(
      result.artifacts.find((artifact) => artifact.relativePath === ".claude/commands/long.md")?.summary,
    ).toHaveLength(240);
    expect(
      result.artifacts.find((artifact) => artifact.relativePath === ".claude/agents/reviewer.md"),
    ).not.toHaveProperty("summary");
    expect(
      result.artifacts.find((artifact) => artifact.relativePath === ".claude/skills/broken/SKILL.md"),
    ).not.toHaveProperty("summary");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ location: ".claude/skills/broken/SKILL.md", code: "malformed" }),
    ]);
  });
});
