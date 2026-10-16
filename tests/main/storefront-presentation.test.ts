import { readPublicationContentChecks } from "../../src/main/storefronts/content-checks";
import { rm, readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { publicationFixture, write, commit, git } from "../helpers/publication-fixture";
import { inspectStorefrontFolder } from "../../src/main/storefronts/inspection";
import { readStorefrontDetails, readInspectionPresentation } from "../../src/main/storefronts/presentation";
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("reads a linked storefront's license and publications without changing its files", async () => {
  const f = await publicationFixture();
  roots.push(f.root);
  const before = await readFile(join(f.storefront, "LICENSE"), "utf8");
  const details = await readStorefrontDetails(f.data, "storefront");
  expect(details).toMatchObject({ status: "ready", license: "MIT", publications: [] });
  expect(await readFile(join(f.storefront, "LICENSE"), "utf8")).toBe(before);
  expect(await readStorefrontDetails(f.data, "workshop")).toMatchObject({ status: "blocked" });
});
it("shows a recognized copy's changed skill count before linking the selected folder", async () => {
  const f = await publicationFixture();
  roots.push(f.root);
  const preview = await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  await f.operations.apply({ planId: preview.plan.planId });
  const path = "packages/demo/skills/demo/SKILL.md";
  await write(f.workshop, path, (await readFile(join(f.workshop, path), "utf8")) + "\nCheck the final output.\n");
  await commit(f.workshop);
  const registry = await f.registry.read();
  if (registry.status !== "ready") throw new Error("Fixture registry unavailable.");
  const workshop = registry.state.sources.find((source) => source.id === "workshop")!;
  const inspection = await inspectStorefrontFolder(f.storefront, workshop);
  const result = await readInspectionPresentation(f.data, f.storefront, inspection);
  expect(result).toMatchObject({
    displayRoot: "storefront",
    license: "MIT",
    plugins: [{ pluginId: "demo", recognition: "recognized", behindSkills: 1 }],
  });
});

it("reads the storefront description from GitHub marketplace metadata", async () => {
  const f = await publicationFixture();
  roots.push(f.root);
  await write(
    f.storefront,
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      name: "public-tools",
      metadata: { description: "Agent skills for content creation." },
      plugins: [],
    }),
  );
  expect(await readStorefrontDetails(f.data, "storefront")).toMatchObject({
    status: "ready",
    description: "Agent skills for content creation.",
  });
});

it("checks current workshop content before a new destination has a name without writing files", async () => {
  const f = await publicationFixture();
  roots.push(f.root);
  const path = "packages/demo/skills/demo/SKILL.md";
  const content = (await readFile(join(f.workshop, path), "utf8")) + "\nWrite to /Users/example/private/assets.\n";
  await write(f.workshop, path, content);
  expect(await readPublicationContentChecks(f.data, "demo")).toMatchObject({
    findings: [{ code: "personal-path", excerpt: "/Users/example/private/assets" }],
  });
  expect(await readFile(join(f.workshop, path), "utf8")).toBe(content);
  await expect(readPublicationContentChecks(f.data, "../private")).rejects.toThrow();
});

it("checks the description that will appear in the storefront README", async () => {
  const f = await publicationFixture();
  roots.push(f.root);
  const path = "packages/demo/omni.plugin.json";
  const manifest = JSON.parse(await readFile(join(f.workshop, path), "utf8"));
  await write(
    f.workshop,
    path,
    JSON.stringify({ ...manifest, description: "Les fichiers sont dans le projet et vous pouvez les modifier." }),
  );
  expect((await readPublicationContentChecks(f.data, "demo")).findings).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "non-english", file: "README.md" })]),
  );
});

it("projects the real origin while redacting remote credentials", async () => {
  const f = await publicationFixture();
  roots.push(f.root);
  expect(await readStorefrontDetails(f.data, "storefront")).toMatchObject({
    inspection: { originUrl: f.origin },
  });
  await git(
    f.storefront,
    "remote",
    "set-url",
    "origin",
    "https://user:secret@git.example.com/team/tools.git?token=secret#secret",
  );
  expect(await readStorefrontDetails(f.data, "storefront")).toMatchObject({
    inspection: { originUrl: "https://git.example.com/team/tools.git" },
  });
});

it("keeps a relative local origin distinct from a GitHub repository shorthand", async () => {
  const f = await publicationFixture();
  roots.push(f.root);
  await git(f.storefront, "remote", "set-url", "origin", "remotes/tools.git");
  const details = await readStorefrontDetails(f.data, "storefront");
  expect(details).toMatchObject({ inspection: { originUrl: "remotes/tools.git" } });
  if (details.status !== "ready") throw new Error("Fixture storefront unavailable.");
  expect(details.inspection.githubRepository).toBeUndefined();
});

it.each(["git@github.com:fixture/tools.git", "ssh://git@github.com/fixture/tools.git"])(
  "preserves GitHub identity for SSH origin %s after redaction",
  async (origin) => {
    const f = await publicationFixture();
    roots.push(f.root);
    await git(f.storefront, "remote", "set-url", "origin", origin);
    expect(await readStorefrontDetails(f.data, "storefront")).toMatchObject({
      inspection: { githubRepository: "fixture/tools" },
    });
  },
);
