import { describe, expect, it } from "vitest";

import { bundleHash, bundleRoot, readBundle } from "../../src/main/omni-skills-bundle";

function skillMd(bundle: Awaited<ReturnType<typeof readBundle>>, name: string): string {
  const skill = bundle.find((item) => item.name === name);
  const file = skill?.files.find((item) => item.relativePath === "SKILL.md");
  if (!file) throw new Error(`No SKILL.md found for ${name}.`);
  return file.content;
}

describe("Omni skills bundle", () => {
  it("reads the eleven bundled skills with a stable content hash", async () => {
    const root = bundleRoot({ appPath: process.cwd(), isPackaged: false });
    const bundle = await readBundle(root);

    expect(bundle.map((skill) => skill.name)).toEqual([
      "omni-audit",
      "omni-bootstrap",
      "omni-compose",
      "omni-explain",
      "omni-lessons",
      "omni-marketplace-routing",
      "omni-project-sync",
      "omni-share",
      "omni-skill-authoring",
      "omni-suggest",
      "omni-summarize",
    ]);
    expect(bundle.every((skill) => skill.files.some((file) => file.relativePath === "SKILL.md"))).toBe(true);
    expect(bundleHash(bundle)).toBe(bundleHash(await readBundle(root)));
  });

  it("ships a read-only audit with a fictional self-contained visual report", async () => {
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const body = skillMd(bundle, "omni-audit");
    for (const trigger of [
      "audit my skills",
      "which skills overlap",
      "clean up my skills",
      "omni_skill_inventory",
      "at most 40",
      "read-only until",
      "question tool",
      "five-line",
      "multi-select",
      "at most four",
      "Never write a SKILL.md by hand",
    ])
      expect(body).toContain(trigger);
    for (const instruction of [
      "Read every page",
      "one finding per name",
      "Later pages contain units",
      "Description caps are aggregated",
      "forget this use",
      "omni_preview_remove",
      "supports Undo from the receipt",
      "unsafe target stays blocked",
      "cursor: nextCursor",
      "stable unit `id`s",
      "`root` +",
      "working directory",
      "If none contains it",
      "12-hex `hash` is display",
    ])
      expect(body).toContain(instruction);
    for (const sentence of [
      "approval for this exact plan counts; do not ask again",
      "no or unclear means do nothing",
      'approval: "omni"',
      "Omni preview, `omni_apply`, and its receipt",
      "never run `npx skills add` directly",
    ])
      expect(body).toContain(sentence);
    expect(body.trimEnd().split("\n").length).toBeLessThanOrEqual(100);
    const example = bundle
      .find((item) => item.name === "omni-audit")
      ?.files.find((file) => file.relativePath === "report-example.html")?.content;
    expect(example).toContain("acme-app");
    expect(example).toContain("prefers-color-scheme: dark");
    for (const privateText of [["lev", "els"].join(""), "revamping-a-screen", "f686bd54", "/Users/"])
      expect(example).not.toContain(privateText);
    expect(example).not.toMatch(/<(?:script|link)|https?:\/\//u);
  });

  it("routes sharing to one workflow and synchronizes the plugin copy", async () => {
    const { readFile } = await import("node:fs/promises");
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    const share = skillMd(bundle, "omni-share");
    for (const instruction of [
      "share this plugin",
      "share this skill",
      "publish",
      "lead magnet",
      "storefront",
      "omni_status",
      "omni_preview_link_storefront",
      "audience",
      "vertical",
      "public repository",
      "generic",
      "workshop",
      "English",
      "working examples",
      "omni_preview_publish",
      "conflictChoices",
      "file and line",
      "owner's approval in Omni",
      "claude plugin",
      "codex plugin",
    ])
      expect(share).toContain(instruction);
    expect(share.trimEnd().split("\n").length).toBeLessThanOrEqual(100);
    expect(skillMd(bundle, "omni-bootstrap")).toContain("For sharing or publishing, follow `omni-share`");
    for (const item of bundle) {
      const body = skillMd(bundle, item.name);
      expect(await readFile(`plugins/omni/skills/${item.name}/SKILL.md`, "utf8")).toBe(body);
      if (item.name !== "omni-share") {
        expect(body).toContain("For sharing or publishing, follow `omni-share`");
        expect(body).not.toContain("Publication always requires");
      }
    }
  });

  it("names every skill folder after its frontmatter name", async () => {
    const root = bundleRoot({ appPath: process.cwd(), isPackaged: false });
    const bundle = await readBundle(root);

    for (const skill of bundle) {
      const content = skillMd(bundle, skill.name);
      expect(content).toMatch(new RegExp(`^---\\nname: ${skill.name}\\n`));
    }
  });
  it("routes external skill installation through Omni in every installed agent skill", async () => {
    const bundle = await readBundle(bundleRoot({ appPath: process.cwd(), isPackaged: false }));
    for (const item of bundle) expect(skillMd(bundle, item.name)).toContain("never run `npx skills add` directly");
  });

  it("preserves command triggers and accepts prior consent without repeating approval", async () => {
    const root = bundleRoot({ appPath: process.cwd(), isPackaged: false });
    const bundle = await readBundle(root);

    expect(skillMd(bundle, "omni-suggest")).toContain("what skills would help this project");
    expect(skillMd(bundle, "omni-explain")).toContain("why Omni flags something");
    expect(skillMd(bundle, "omni-summarize")).toContain("what an agent session did");
    expect(skillMd(bundle, "omni-compose")).toContain("Compose up to three project skills");
    for (const name of ["omni-suggest", "omni-explain", "omni-summarize"]) {
      const content = skillMd(bundle, name);
      expect(content).toContain("approval for this exact plan counts; do not ask again");
      expect(content).toContain("no or unclear means do nothing");
      expect(content).toContain('approval: "omni"');
      expect(content).toContain("Omni preview, `omni_apply`, and its receipt");
    }
  });
});
