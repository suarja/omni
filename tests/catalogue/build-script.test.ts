import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { tagsForText } from "../../src/domain/stack-tags";
import {
  candidatePaths,
  extractInitialSkills,
  extractInstallCommand,
  extractSoftwareApplicationJsonLd,
  findSkillMdInTree,
  resolveSkillMdPath,
} from "../../packages/omni-catalogue/scripts/build.mjs";

const FIXTURES_ROOT = join(import.meta.dirname, "../fixtures/catalogue");

async function fixture(name: string): Promise<string> {
  return readFile(join(FIXTURES_ROOT, name), "utf8");
}

describe("extractInitialSkills", () => {
  it("extracts every entry from the home page's initialSkills payload", async () => {
    const html = await fixture("home-fragment.html");
    const entries = extractInitialSkills(html, 1);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      ownerRepo: "anthropics/skills",
      skill: "frontend-design",
      name: "frontend-design",
      installs: 886327,
      weeklyInstalls: [24780, 26152, 25773, 24760, 26482, 26382, 24200, 22533],
      official: true,
    });
    expect(entries[1]!.official).toBe(false);
  });

  it("deduplicates by source + skillId", () => {
    const html =
      'self.__next_f.push([1,"{\\"initialSkills\\":[' +
      '{\\"source\\":\\"a/b\\",\\"skillId\\":\\"x\\",\\"name\\":\\"x\\",\\"installs\\":1,\\"weeklyInstalls\\":[]},' +
      '{\\"source\\":\\"a/b\\",\\"skillId\\":\\"x\\",\\"name\\":\\"x\\",\\"installs\\":1,\\"weeklyInstalls\\":[]},' +
      '{\\"source\\":\\"a/b\\",\\"skillId\\":\\"y\\",\\"name\\":\\"y\\",\\"installs\\":2,\\"weeklyInstalls\\":[]}' +
      ']}"])';
    const entries = extractInitialSkills(html, 1);
    expect(entries.map((entry: { skill: string }) => entry.skill)).toEqual(["x", "y"]);
  });

  it("fails loudly (throws) when the page yields fewer entries than expected", async () => {
    const html = await fixture("home-fragment.html");
    expect(() => extractInitialSkills(html)).toThrow(/skills\.sh home page layout changed/);
  });

  it("does not throw when the minimum is met", async () => {
    const html = await fixture("home-fragment.html");
    expect(() => extractInitialSkills(html, 3)).not.toThrow();
  });
});

describe("extractSoftwareApplicationJsonLd", () => {
  it("reads the first unescaped SoftwareApplication block, never the escaped RSC duplicate", async () => {
    const html = await fixture("skill-page.html");
    const jsonLd = extractSoftwareApplicationJsonLd(html);
    expect(jsonLd).toEqual({
      name: "frontend-design",
      description: "Guidance for distinctive, intentional visual design when building new UI with React and Tailwind.",
    });
  });

  it("returns undefined when there is no JSON-LD block", () => {
    expect(extractSoftwareApplicationJsonLd("<html><body>nothing here</body></html>")).toBeUndefined();
  });
});

describe("extractInstallCommand", () => {
  it("parses the owner/repo and skill id out of the install command", async () => {
    const html = await fixture("skill-page.html");
    expect(extractInstallCommand(html)).toEqual({ ownerRepo: "anthropics/skills", skill: "frontend-design" });
  });

  it("returns undefined when there is no install command", () => {
    expect(extractInstallCommand("<html></html>")).toBeUndefined();
  });
});

describe("candidatePaths", () => {
  it("tries at most 6 convention paths, root first", () => {
    const paths = candidatePaths("my-skill");
    expect(paths).toHaveLength(6);
    expect(paths[0]).toBe("SKILL.md");
    expect(paths).toContain("skills/my-skill/SKILL.md");
    expect(paths).toContain(".claude/skills/my-skill/SKILL.md");
    expect(paths).toContain(".agents/skills/my-skill/SKILL.md");
    expect(paths).toContain(".codex/skills/my-skill/SKILL.md");
    expect(paths).toContain(".cursor/skills/my-skill/SKILL.md");
  });
});

describe("resolveSkillMdPath (fake fetch, no network)", () => {
  it("stops at the first candidate that resolves", async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string) => {
      calls.push(url);
      return { ok: url.endsWith("/skills/my-skill/SKILL.md") };
    };
    const path = await resolveSkillMdPath("owner/repo", "my-skill", fakeFetch);
    expect(path).toBe("skills/my-skill/SKILL.md");
    // Root SKILL.md was tried and missed, then the winning candidate — never any candidate after it.
    expect(calls).toEqual([
      "https://raw.githubusercontent.com/owner/repo/HEAD/SKILL.md",
      "https://raw.githubusercontent.com/owner/repo/HEAD/skills/my-skill/SKILL.md",
    ]);
  });

  it("returns undefined when no candidate resolves, having tried all six", async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string) => {
      calls.push(url);
      return { ok: false };
    };
    const path = await resolveSkillMdPath("owner/repo", "my-skill", fakeFetch);
    expect(path).toBeUndefined();
    expect(calls).toHaveLength(6);
  });
});

// build.mjs no longer keeps its own frontmatter reader or tag table — it imports
// `src/adapters/inventory/frontmatter.ts`'s `parseFrontmatter` and `src/domain/stack-tags.ts`'s
// `tagsForText` directly (Node strips their type annotations at load time; see build.mjs's
// header comment and the package README's "Node version" section), so there is nothing left to
// keep "in sync" and no copy of either to test here. `parseFrontmatter` already has its own
// coverage via `tests/adapters/inventory/detectors.test.ts`; `tagsForText` below is exercised
// directly from its one module of record.

describe("tagsForText (src/domain/stack-tags.ts, the module build.mjs imports directly)", () => {
  it("tags text mentioning React and Tailwind", () => {
    expect(tagsForText("Guidance for building UI with React and Tailwind CSS.")).toEqual(
      expect.arrayContaining(["react", "tailwind"]),
    );
  });

  it("does not match a tag inside a longer, unrelated word", () => {
    // "reactive" contains "react" as a substring but is not the React tag.
    expect(tagsForText("A reactive programming exercise.")).not.toContain("react");
  });

  it("matches a scoped npm package keyword", () => {
    expect(tagsForText("Wires up @clerk/nextjs for auth.")).toContain("clerk");
  });

  it("returns no tags for empty text", () => {
    expect(tagsForText("")).toEqual([]);
  });
});

describe("findSkillMdInTree", () => {
  it("matches a SKILL.md whose parent folder is the skill id, in a categorised layout", () => {
    const tree = [
      { path: "README.md", type: "blob" },
      { path: "skills/engineering/grill-me/SKILL.md", type: "blob" },
      { path: "skills/engineering/grill-me/reference.md", type: "blob" },
      { path: "skills/writing/unslop/SKILL.md", type: "blob" },
    ];
    expect(findSkillMdInTree(tree, "grill-me", "skills")).toBe("skills/engineering/grill-me/SKILL.md");
  });

  it("prefers the shallowest match when several parents share the skill id", () => {
    const tree = [
      { path: "examples/nested/grill-me/SKILL.md", type: "blob" },
      { path: "skills/grill-me/SKILL.md", type: "blob" },
    ];
    expect(findSkillMdInTree(tree, "grill-me", "skills")).toBe("skills/grill-me/SKILL.md");
  });

  it("matches a root SKILL.md only when the skill id equals the repo name", () => {
    const tree = [{ path: "SKILL.md", type: "blob" }];
    expect(findSkillMdInTree(tree, "my-repo", "my-repo")).toBe("SKILL.md");
    expect(findSkillMdInTree(tree, "some-other-skill", "my-repo")).toBeUndefined();
  });

  it("ignores non-blob entries (trees) and files that are not named SKILL.md", () => {
    const tree = [
      { path: "skills/grill-me", type: "tree" },
      { path: "skills/grill-me/NOTES.md", type: "blob" },
    ];
    expect(findSkillMdInTree(tree, "grill-me", "skills")).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    const tree = [{ path: "skills/other-skill/SKILL.md", type: "blob" }];
    expect(findSkillMdInTree(tree, "grill-me", "repo")).toBeUndefined();
  });
});
