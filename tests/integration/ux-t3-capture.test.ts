import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { seedFixture, registerOperations, treeDigest, projectSkill } from "./skill-adoption-fixture";

it("copies a locked external skill with its exact provenance and leaves every project byte unchanged", async () => {
  const fixture = await seedFixture();
  const copiedFrom = {
    source: "example/skills",
    ref: "v1.2.3",
    skillPath: "skills/demo",
    computedHash: "a".repeat(64),
  };
  await writeFile(
    join(fixture.projectRoot, "skills-lock.json"),
    JSON.stringify({ version: 1, skills: { demo: { ...copiedFrom, sourceType: "github" } } }),
  );
  const before = await treeDigest(fixture.projectRoot);
  const operations = await registerOperations(fixture);
  const preview = await operations.previewOperation({
    kind: "import-artifact",
    source: { kind: "project", id: fixture.project.id, grantHandle: fixture.project.grantHandle },
    relativePath: projectSkill,
    target: { newPackageName: "owned-copy", description: "Owned copies of useful external skills." },
  });
  expect(preview.status, JSON.stringify(preview)).toBe("ready");
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  const result = await operations.applyOperation({ planId: preview.plan.planId });
  expect(result).toMatchObject({ status: "applied", receipt: { provenance: { copiedFrom } } });
  expect(await treeDigest(fixture.projectRoot)).toBe(before);
  expect((await operations.skillManagement.readProjectSkills!(fixture.project.id)).skills[0]?.origin.kind).toBe(
    "external",
  );
  const manifest = JSON.parse(await readFile(join(fixture.sourceRoot, "packages/owned-copy/omni.plugin.json"), "utf8"));
  expect(manifest.provenance).toBeUndefined();
  expect(manifest.artifacts[0].provenance).toMatchObject({
    ...copiedFrom,
    project: { id: fixture.project.id },
    importedAt: expect.any(String),
  });
});

it("reports an incomplete project link and lets the toast undo only the marketplace copy while retaining the local edit", async () => {
  const fixture = await seedFixture();
  let edited = false;
  const operations = await registerOperations(fixture, undefined, async (path, content, options) => {
    await writeFile(path, content, options);
    if (!edited && path.includes("packages/captured/skills/demo/")) {
      edited = true;
      await writeFile(join(fixture.projectRoot, projectSkill, "notes.md"), "Concurrent project edit\n");
    }
  });
  const preview = await operations.previewOperation({
    kind: "import-artifact",
    source: { kind: "project", id: fixture.project.id, grantHandle: fixture.project.grantHandle },
    relativePath: projectSkill,
    target: { newPackageName: "captured", description: "Reusable project skills." },
  });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  const result = await operations.applyOperation({ planId: preview.plan.planId });
  expect(result).toMatchObject({
    status: "failed",
    receipt: { diagnostic: expect.stringContaining("project link did not complete") },
  });
  const restore = await operations.skillManagement.preview(
    { kind: "restore", operationId: result!.receipt.operationId },
    { kind: "desktop" },
  );
  expect(restore.status, JSON.stringify(restore)).toBe("ready");
  if (restore.status !== "ready") throw new Error(restore.reason);
  expect(
    (
      await operations.skillManagement.apply(restore.intentId, {
        kind: "desktop",
        effectFingerprint: restore.effectFingerprint,
        approvedAt: new Date().toISOString(),
      })
    ).status,
  ).toBe("restored");
  expect(await readFile(join(fixture.projectRoot, projectSkill, "notes.md"), "utf8")).toBe("Concurrent project edit\n");
});

it.each(["operation", "toast"])(
  "captures and links exact project copies, then restores the link before the import through %s",
  async (route) => {
    const fixture = await seedFixture();
    await mkdir(join(fixture.sourceRoot, "packages/captured"));
    await writeFile(
      join(fixture.sourceRoot, "packages/captured/omni.plugin.json"),
      JSON.stringify({ format: "omni.plugin/1", id: "captured", name: "captured", version: "0.1.0", artifacts: [] }),
    );
    const marketplacePath = join(fixture.sourceRoot, "omni.marketplace.json");
    const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
    marketplace.packages.push({ path: "packages/captured" });
    await writeFile(marketplacePath, JSON.stringify(marketplace));
    const before = await treeDigest(fixture.projectRoot);
    let operations = await registerOperations(fixture);
    const request = {
      kind: "import-artifact",
      source: { kind: "project", id: fixture.project.id, grantHandle: fixture.project.grantHandle },
      relativePath: projectSkill,
      target: { packageId: "packages/captured" },
    };
    const preview = await operations.previewOperation(request);
    expect(preview.status, JSON.stringify(preview)).toBe("ready");
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    const result = await operations.applyOperation({ planId: preview.plan.planId });
    expect(result?.status).toBe("applied");
    expect((await operations.skillManagement.readProjectSkills!(fixture.project.id)).skills[0]?.origin).toMatchObject({
      kind: "mine",
      packageId: "packages/captured",
      artifactPath: "skills/demo",
    });
    expect(await treeDigest(fixture.projectRoot)).toBe(before);
    expect(await operations.previewOperation(request)).toMatchObject({
      status: "blocked",
      reason: "duplicate-logical-id",
    });
    operations = await registerOperations(fixture);
    if (route === "toast") {
      const restore = await operations.skillManagement.preview(
        { kind: "restore", operationId: result!.receipt.operationId },
        { kind: "desktop" },
      );
      expect(restore.status, JSON.stringify(restore)).toBe("ready");
      if (restore.status !== "ready") throw new Error(restore.reason);
      const restored = await operations.skillManagement.apply(restore.intentId, {
        kind: "desktop",
        effectFingerprint: restore.effectFingerprint,
        approvedAt: new Date().toISOString(),
      });
      expect(restored.status, JSON.stringify(restored)).toBe("restored");
    } else {
      const restore = await operations.previewOperation({
        kind: "restore-import",
        operationId: result!.receipt.operationId,
      });
      expect(restore.status, JSON.stringify(restore)).toBe("ready");
      if (restore.status !== "ready") throw new Error(restore.diagnostic);
      expect(await operations.applyOperation({ planId: restore.plan.planId })).toMatchObject({ status: "applied" });
    }
    expect((await operations.skillManagement.readProjectSkills!(fixture.project.id)).skills[0]?.origin.kind).toBe(
      "project-only",
    );
    expect(await treeDigest(fixture.projectRoot)).toBe(before);
  },
);
