import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedUxPass2Fixture } from "./ux-pass-2-fixture";
import { treeDigest } from "./skill-adoption-fixture";
import { run } from "../ipc/apply-ipc-helpers";
import { parseMarketplaceManifest, parsePackageManifest } from "../../src/domain/marketplace-format";
import type { OperationsIpcServices } from "../../src/main/operations-ipc";

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function apply(operations: OperationsIpcServices, request: unknown) {
  const preview = await operations.previewOperation(request);
  expect(preview.status, JSON.stringify(preview)).toBe("ready");
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  const result = await operations.applyOperation({ planId: preview.plan.planId });
  expect(result?.status, JSON.stringify(result)).toBe("applied");
  expect(result?.receipt.git.commit).toMatch(/^[a-f0-9]{40}$/u);
  return result!;
}

async function expectSynchronized(root: string): Promise<void> {
  const marketplace = parseMarketplaceManifest(await readJson(join(root, "omni.marketplace.json")));
  const claude = await readJson(join(root, ".claude-plugin/marketplace.json"));
  const codex = await readJson(join(root, ".agents/plugins/marketplace.json"));
  expect(claude.metadata.description).toBe(claude.description);
  expect(codex.interface.displayName).toBe("UX2 Agent Plugins");
  expect(claude.plugins).toHaveLength(marketplace.packages.length);
  expect(codex.plugins).toHaveLength(marketplace.packages.length);
  for (const { path } of marketplace.packages) {
    const plugin = parsePackageManifest(await readJson(join(root, path, "omni.plugin.json")));
    expect(plugin.artifacts.length).toBeGreaterThan(0);
    const folders = (await readdir(join(root, path, "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => `skills/${name}`)
      .sort();
    expect(plugin.artifacts.map(({ path }) => path).sort()).toEqual(folders);
    for (const artifact of plugin.artifacts)
      expect(await readFile(join(root, path, artifact.path, "SKILL.md"), "utf8")).toContain("name:");
    const entries = [
      await readJson(join(root, path, ".claude-plugin/plugin.json")),
      await readJson(join(root, path, ".codex-plugin/plugin.json")),
      claude.plugins.find((entry: { source: string }) => entry.source === `./${path}`),
      codex.plugins.find((entry: { source: { path: string } }) => entry.source.path === `./${path}`),
    ];
    for (const entry of entries) {
      expect(entry).toMatchObject({ name: plugin.name, version: plugin.version });
      expect(entry.description).toBe(plugin.description);
    }
    expect(entries[1].skills).toBe("./skills/");
  }
}

it("keeps all fixture manifests synchronized through new-plugin capture, copy and Describe without replacing plugin provenance", async () => {
  const fixture = await seedUxPass2Fixture();
  await expectSynchronized(fixture.sourceRoot);
  const legacy = {
    importedFrom: {
      sourceName: "Original plugin owner",
      relativePath: "plugins/design",
      contentHash: "b".repeat(64),
      importedAt: "2026-10-11T00:00:00.000Z",
    },
    reason: "Original plugin provenance.",
  };
  for (const name of ["design", "build-to-show"]) {
    const path = join(fixture.sourceRoot, "packages", name, "omni.plugin.json");
    await writeFile(path, JSON.stringify({ ...(await readJson(path)), provenance: legacy }, null, 2) + "\n");
  }
  await run("git", ["-C", fixture.sourceRoot, "-c", "core.hooksPath=/dev/null", "add", "."]);
  await run("git", [
    "-C",
    fixture.sourceRoot,
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "Retain legacy plugin provenance",
  ]);
  const { registerRegistryIpcHandlers } = await import("../../src/main/registry-ipc");
  const registry = registerRegistryIpcHandlers(() => undefined, { userDataPath: fixture.userDataPath });
  const { registerOperationsIpcHandlers } = await import("../../src/main/operations-ipc");
  const operations = registerOperationsIpcHandlers(() => undefined, registry, {
    userDataPath: fixture.userDataPath,
    homeDir: fixture.agentHomePath,
  });
  await operations.skillManagement.initialize();
  const alpha = fixture.projects[0]!;
  const grantHandle = await registry.getGrantForEntry({ kind: "project", id: alpha.id });
  const source = { kind: "project", id: alpha.id, grantHandle };
  await apply(operations, {
    kind: "import-artifact",
    source,
    relativePath: ".claude/skills/local-tool",
    target: { newPackageName: "captured", description: "Reusable project tools." },
  });
  await expectSynchronized(fixture.sourceRoot);
  const beforeCopy = await treeDigest(alpha.root);
  const copied = await apply(operations, {
    kind: "import-artifact",
    source,
    relativePath: ".claude/skills/grill-me",
    target: { packageId: "packages/design" },
  });
  expect(await treeDigest(alpha.root)).toBe(beforeCopy);
  const design = parsePackageManifest(await readJson(join(fixture.sourceRoot, "packages/design/omni.plugin.json")));
  expect(design.provenance).toEqual(legacy);
  expect(design.artifacts.find(({ path }) => path === "skills/grill-me")?.provenance).toMatchObject({
    source: "mattpocock/skills",
    ref: "main",
    skillPath: "skills/grill-me",
    computedHash: "a".repeat(64),
    project: { id: alpha.id, name: "alpha" },
    importedAt: expect.any(String),
  });
  await expectSynchronized(fixture.sourceRoot);
  const local = join(alpha.root, ".claude/skills/second-local");
  await mkdir(local);
  await writeFile(
    join(local, "SKILL.md"),
    "---\nname: second-local\ndescription: Another project capability.\n---\n# Second local\n",
  );
  await apply(operations, {
    kind: "import-artifact",
    source,
    relativePath: ".claude/skills/second-local",
    target: { packageId: "packages/build-to-show" },
  });
  const captured = parsePackageManifest(
    await readJson(join(fixture.sourceRoot, "packages/build-to-show/omni.plugin.json")),
  );
  expect(captured.provenance).toEqual(legacy);
  expect(captured.artifacts.find(({ path }) => path === "skills/second-local")?.provenance).toMatchObject({
    source: "alpha",
    project: { id: alpha.id, name: "alpha" },
  });
  await apply(operations, {
    kind: "describe-plugin",
    packageId: "packages/build-to-show",
    description: "Share shipped work with a product audience.",
  });
  await expectSynchronized(fixture.sourceRoot);
  expect(
    parsePackageManifest(await readJson(join(fixture.sourceRoot, "packages/build-to-show/omni.plugin.json")))
      .provenance,
  ).toEqual(legacy);
  const beforeRestore = await treeDigest(alpha.root);
  await apply(operations, { kind: "restore-import", operationId: copied.receipt.operationId });
  await expectSynchronized(fixture.sourceRoot);
  expect(await treeDigest(alpha.root)).toBe(beforeRestore);
  expect((await run("git", ["-C", fixture.sourceRoot, "status", "--porcelain"])).stdout).toBe("");
});
