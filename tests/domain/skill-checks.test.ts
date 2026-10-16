import { describe, expect, it } from "vitest";

import { checkSkill } from "../../src/domain/skill-checks";

const ownerStyleSkill = `---
name: marketplace-skill-contributor
description: >-
  Use when creating, importing, or updating a skill in a marketplace and the
  marketplace manifests need to stay aligned.
---

# Marketplace skill contributor

Read \`references/protocol.md\` before changing a marketplace skill.
`;

function findings(content: string, marketplace: string[] = []): ReturnType<typeof checkSkill> {
  return checkSkill({
    folderName: "marketplace-skill-contributor",
    files: [
      { path: "SKILL.md", content },
      { path: "references/protocol.md", content: "Protocol." },
    ],
    marketplace: { skillNames: marketplace },
  });
}

describe("checkSkill", () => {
  it("accepts the owner's block-scalar frontmatter shape and existing references", () => {
    expect(findings(ownerStyleSkill)).toEqual([]);
  });

  it.each(["out.json", "src/app/page.tsx"])("treats `%s` as prose outside bundled folders", (path) => {
    expect(findings(`${ownerStyleSkill}\nWrite the result to \`${path}\` in your project.`)).toEqual([]);
  });

  it.each(["scripts/missing.sh", "./notes.md", "[missing](notes.md)"])(
    "reports a missing bundled-file reference in %s",
    (reference) => {
      const result = checkSkill({
        folderName: "marketplace-skill-contributor",
        files: [
          {
            path: "SKILL.md",
            content: `${ownerStyleSkill}\nRead ${reference.startsWith("[") ? reference : `\`${reference}\``}.`,
          },
          { path: "references/protocol.md", content: "Protocol." },
          { path: "scripts/build.ts", content: "export {};" },
        ],
        marketplace: { skillNames: [] },
      });
      expect(result).toEqual([expect.objectContaining({ severity: "error", code: "referenced-file-missing" })]);
    },
  );

  it("reports a missing frontmatter block", () => {
    expect(findings("# Skill\n\nUse when the owner asks.")).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error", code: "frontmatter-missing" })]),
    );
  });

  it("reports placeholders as errors and missing triggers as a warning", () => {
    const result = findings(
      `---\nname: marketplace-skill-contributor\ndescription: Helpful skill\n---\n\nTODO: <your-example>\n`,
    );
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", code: "placeholder-text" }),
        expect.objectContaining({ severity: "warning", code: "description-trigger" }),
      ]),
    );
  });

  it("reports a duplicate skill name case-insensitively", () => {
    expect(findings(ownerStyleSkill, ["Marketplace-Skill-Contributor"])).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "error", code: "duplicate-skill-name" })]),
    );
  });

  it("reports missing referenced files and unsafe file paths", () => {
    const result = checkSkill({
      folderName: "marketplace-skill-contributor",
      files: [
        {
          path: "SKILL.md",
          content: `${ownerStyleSkill}\nSee [missing](references/missing.md) and \`../escape.ts\`.`,
        },
        { path: "../outside.md", content: "outside" },
      ],
      marketplace: { skillNames: [] },
    });
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "error", code: "referenced-file-missing" }),
        expect.objectContaining({ severity: "error", code: "file-path-unsafe" }),
      ]),
    );
  });
});
