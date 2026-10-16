import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { observeSkillOrigins } from "../../src/adapters/inventory/skill-origins";
import { createLocalInventoryPort } from "../../src/adapters/inventory/local-filesystem";
import { createObservedArtifact } from "../../src/domain/inventory";

const roots: string[] = [];
const hashFolder = (files: readonly Readonly<{ path: string; bytes: Uint8Array }>[]): string => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path, "utf8");
    hash.update(file.bytes);
  }
  return hash.digest("hex");
};

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-skill-origin-"));
  roots.push(root);
  return root;
}

function observedSkill(id: string, relativePath: string) {
  return createObservedArtifact({
    id,
    physicalIdentity: relativePath,
    projectionPaths: [relativePath],
    kind: "skill",
    relativePath,
    displayPath: relativePath,
    providerIds: ["claude-code"],
    scope: "project",
    confidence: "exact",
    symlinkState: "none",
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("skill origin observation", () => {
  it("returns the copy fingerprint already computed during foreign-lock verification", async () => {
    const root = await createRoot(),
      folder = ".agents/skills/review";
    await mkdir(join(root, folder), { recursive: true });
    const bytes = Buffer.from("Published copy.\n");
    await writeFile(join(root, folder, "SKILL.md"), bytes);
    await writeFile(
      join(root, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          review: { source: "owner/tools", sourceType: "github", computedHash: "a".repeat(64) },
        },
      }),
    );
    const observed = await observeSkillOrigins(createLocalInventoryPort(root), [
      observedSkill("review", `${folder}/SKILL.md`),
    ]);
    expect(observed.origins[0]).toMatchObject({
      verification: "modified",
      copyHash: hashFolder([{ path: "SKILL.md", bytes }]),
    });
  });
  it("verifies complete folders independently for duplicate keys across harness locations", async () => {
    const root = await createRoot();
    const agents = ".agents/skills/review";
    const claude = ".claude/skills/review";
    await mkdir(join(root, agents), { recursive: true });
    await mkdir(join(root, claude), { recursive: true });
    const agentSkill = Buffer.from("# Review\n");
    const agentGuide = Buffer.from("shared guide\n");
    const claudeSkill = Buffer.from("# Review\n");
    const claudeGuide = Buffer.from("modified guide\n");
    await writeFile(join(root, agents, "SKILL.md"), agentSkill);
    await writeFile(join(root, agents, "guide.md"), agentGuide);
    await writeFile(join(root, claude, "SKILL.md"), claudeSkill);
    await writeFile(join(root, claude, "guide.md"), claudeGuide);
    const recordedHash = hashFolder([
      { path: "SKILL.md", bytes: agentSkill },
      { path: "guide.md", bytes: agentGuide },
    ]);
    await writeFile(
      join(root, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          review: {
            source: "Get-Convex/agent-skills",
            sourceType: "github",
            computedHash: recordedHash,
            ref: "main",
          },
        },
      }),
    );

    const result = await observeSkillOrigins(createLocalInventoryPort(root), [
      observedSkill("agents-review", `${agents}/SKILL.md`),
      observedSkill("claude-review", `${claude}/SKILL.md`),
      observedSkill("codex-review", ".codex/skills/review/SKILL.md"),
    ]);

    expect(result.origins).toMatchObject([
      { artifactId: "agents-review", relativePath: `${agents}/SKILL.md`, verification: "matches-lock" },
      { artifactId: "claude-review", relativePath: `${claude}/SKILL.md`, verification: "modified" },
    ]);
    expect(result.origins).toHaveLength(2);
    expect(result.origins[0]?.source).toEqual({ kind: "github", locator: "get-convex/agent-skills" });
    expect(result.origins[0]).not.toHaveProperty("absoluteRoot");
    expect(result.diagnostics).toEqual([]);
    await expect(readFile(join(root, agents, "guide.md"), "utf8")).resolves.toBe("shared guide\n");
  });

  it("keeps a declared origin when a folder contains a symlink and reports unverified", async () => {
    const root = await createRoot();
    const folder = ".agents/skills/review";
    await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, folder, "SKILL.md"), "# Review\n");
    await writeFile(join(root, "outside.md"), "outside");
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(join(root, "outside.md"), join(root, folder, "link.md")),
    );
    await writeFile(
      join(root, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          review: { source: "owner/tools", sourceType: "github", computedHash: "a".repeat(64) },
        },
      }),
    );

    const result = await observeSkillOrigins(createLocalInventoryPort(root), [
      observedSkill("review", `${folder}/SKILL.md`),
    ]);

    expect(result.origins[0]).toMatchObject({ verification: "unverified", verificationReason: "unsafe-tree" });
    expect(result.diagnostics).toMatchObject([{ code: "unsupported", location: `${folder}/SKILL.md` }]);
  });

  it("treats a missing lock as normal and future locks or dangling entries as diagnostics only", async () => {
    const root = await createRoot();
    const filesystem = createLocalInventoryPort(root);
    const skill = observedSkill("review", ".agents/skills/review/SKILL.md");
    await expect(observeSkillOrigins(filesystem, [skill])).resolves.toEqual({ origins: [], diagnostics: [] });

    await writeFile(
      join(root, "skills-lock.json"),
      JSON.stringify({
        version: 9,
        skills: {
          dangling: { source: "owner/tools", sourceType: "github", computedHash: "a".repeat(64) },
        },
      }),
    );
    const result = await observeSkillOrigins(filesystem, [skill]);
    expect(result.origins).toEqual([]);
    expect(result.diagnostics).toMatchObject([{ code: "unsupported", location: "skills-lock.json" }]);
  });

  it("keeps valid entries when JSON contains one malformed lock entry", async () => {
    const root = await createRoot();
    const folder = ".agents/skills/review";
    await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, folder, "SKILL.md"), "# Review\n");
    await writeFile(
      join(root, "skills-lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          review: { source: "owner/tools", sourceType: "github", computedHash: "a".repeat(64) },
          invalid: { source: "https://example.com/secret", sourceType: "git", computedHash: "bad" },
        },
      }),
    );

    const result = await observeSkillOrigins(createLocalInventoryPort(root), [
      observedSkill("review", `${folder}/SKILL.md`),
    ]);

    expect(result.origins).toHaveLength(1);
    expect(result.diagnostics).toMatchObject([{ code: "unsupported", location: "skills-lock.json" }]);
    expect(JSON.stringify(result)).not.toMatch(/example\.com|secret/);
  });
});
