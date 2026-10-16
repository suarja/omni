import { rm, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publicationFixture, write, git, commit } from "../helpers/publication-fixture";
import type { PreviewMarketplaceResponse } from "../../src/shared/operations-ipc";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const roots: string[] = [];
async function fixture() {
  const f = await publicationFixture();
  roots.push(f.root);
  return f;
}
function ready(value: PreviewMarketplaceResponse) {
  if (value.status !== "ready") throw new Error(value.diagnostic);
  return value.plan;
}
async function publish(f: Awaited<ReturnType<typeof fixture>>) {
  const plan = ready(
    await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }),
  );
  return f.operations.apply({ planId: plan.planId });
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("publishes the first copy, both harnesses and exact README range to the bare origin", async () => {
  const f = await fixture();
  const before = await readFile(join(f.storefront, "README.md"), "utf8");
  const result = await publish(f);
  expect(result).toMatchObject({
    status: "applied",
    receipt: { kind: "publish-plugin", publication: { state: "pushed" } },
  });
  expect(await readFile(join(f.storefront, "plugins/demo/ORIGIN.md"), "utf8")).toContain(f.workshopCommit);
  await expect(readFile(join(f.storefront, "plugins/demo/omni.plugin.json"))).rejects.toThrow();
  for (const path of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"])
    expect(JSON.parse(await readFile(join(f.storefront, path), "utf8")).plugins).toHaveLength(1);
  expect(await readFile(join(f.storefront, "plugins/demo/.codex-plugin/plugin.json"), "utf8")).toContain(
    '"skills": "./skills/"',
  );
  const readme = await readFile(join(f.storefront, "README.md"), "utf8");
  expect(readme.replace(/<!-- omni:plugins -->[\s\S]*?<!-- \/omni:plugins -->\n/u, "")).toBe(before);
  expect(await git(f.origin, "rev-parse", "refs/heads/main")).toBe(await git(f.storefront, "rev-parse", "HEAD"));
  expect(await git(f.storefront, "log", "-1", "--format=%s")).toBe(
    `Publish demo from Workshop@${f.workshopCommit.slice(0, 7)}`,
  );
});
it("merges all classes and resolves two conflicts in opposite directions on apply", async () => {
  const f = await fixture();
  await publish(f);
  await write(f.workshop, "packages/demo/workshop.txt", "workshop\n");
  await write(f.workshop, "packages/demo/added.txt", "added\n");
  await rm(join(f.workshop, "packages/demo/removed.txt"));
  for (const path of ["conflict-a.txt", "conflict-b.txt"]) {
    await write(f.workshop, `packages/demo/${path}`, "workshop\n");
    await write(f.storefront, `plugins/demo/${path}`, "storefront\n");
  }
  await write(f.storefront, "plugins/demo/storefront.txt", "storefront\n");
  await write(
    f.storefront,
    "plugins/demo/ORIGIN.md",
    (await readFile(join(f.storefront, "plugins/demo/ORIGIN.md"), "utf8")) +
      "\n## Storefront-only edits\n\nKeep the translated examples.\n",
  );
  await commit(f.workshop);
  const plan = ready(
    await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }),
  );
  expect(new Set(plan.publication?.files.map((file) => file.classification))).toEqual(
    new Set([
      "unchanged",
      "workshop-changed",
      "storefront-only",
      "conflict",
      "added-in-workshop",
      "removed-in-workshop",
    ]),
  );
  expect(plan.publication?.conflicts).toEqual(["conflict-a.txt", "conflict-b.txt"]);
  expect(
    await f.operations.apply({
      planId: plan.planId,
      conflictChoices: { "conflict-a.txt": "keep-storefront", "conflict-b.txt": "take-workshop" },
    }),
  ).toMatchObject({ status: "applied" });
  expect(await readFile(join(f.storefront, "plugins/demo/conflict-a.txt"), "utf8")).toBe("storefront\n");
  expect(await readFile(join(f.storefront, "plugins/demo/conflict-b.txt"), "utf8")).toBe("workshop\n");
  expect(await readFile(join(f.storefront, "plugins/demo/ORIGIN.md"), "utf8")).toContain(
    "Keep the translated examples.",
  );
  await expect(readFile(join(f.storefront, "plugins/demo/removed.txt"))).rejects.toThrow();
  expect(await readFile(join(f.storefront, "plugins/demo/storefront.txt"), "utf8")).toBe("storefront\n");
  expect(await git(f.origin, "show", "refs/heads/main:plugins/demo/storefront.txt")).toBe("storefront");
});
it.each([
  ["personal-path", "/home/example/project"],
  ["secret", "sk-abcdefghijklmnopqrstuvwxyz"],
  ["email", ["ada", "company.example"].join("@")],
  ["non-english", "Les fichiers sont dans le projet et vous pouvez les modifier."],
])("blocks %s on merged output without writes", async (code, text) => {
  const f = await fixture();
  await write(f.workshop, "packages/demo/leak.md", text!);
  await commit(f.workshop);
  const head = await git(f.storefront, "rev-parse", "HEAD");
  const preview = await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" });
  expect(preview).toMatchObject({
    status: "blocked",
    plan: { publication: { findings: expect.arrayContaining([expect.objectContaining({ code })]) } },
  });
  if (preview.plan) expect(await f.operations.apply({ planId: preview.plan.planId })).toBeUndefined();
  expect(await git(f.storefront, "rev-parse", "HEAD")).toBe(head);
});
it("blocks invalid published skills and missing LICENSE", async () => {
  const f = await fixture();
  await write(f.workshop, "packages/demo/skills/demo/SKILL.md", "# Broken");
  await commit(f.workshop);
  await rm(join(f.storefront, "LICENSE"));
  expect(
    await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }),
  ).toMatchObject({
    status: "blocked",
    plan: {
      publication: {
        findings: expect.arrayContaining([
          expect.objectContaining({ code: "skill-invalid" }),
          expect.objectContaining({ code: "license-missing" }),
        ]),
      },
    },
  });
});
it("checks retained storefront prose and cannot bypass findings with a conflict choice", async () => {
  const f = await fixture();
  await publish(f);
  await write(f.storefront, "plugins/demo/same.txt", "/home/example/private");
  expect(
    await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }),
  ).toMatchObject({ status: "blocked" });
});
it.each(["workshop", "storefront", "remote", "head", "license"])("rejects stale %s after preview", async (change) => {
  const f = await fixture();
  const plan = ready(
    await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }),
  );
  if (change === "workshop") await write(f.workshop, "packages/demo/same.txt", "changed");
  if (change === "storefront") await write(f.storefront, "README.md", "changed");
  if (change === "remote") await git(f.storefront, "remote", "set-url", "origin", join(f.root, "another.git"));
  if (change === "head") {
    await write(f.storefront, "unrelated.txt", "changed");
    await commit(f.storefront);
  }
  if (change === "license") await rm(join(f.storefront, "LICENSE"));
  const head = await git(f.storefront, "rev-parse", "HEAD");
  expect(await f.operations.apply({ planId: plan.planId })).toMatchObject({ status: "failed" });
  expect(await git(f.storefront, "rev-parse", "HEAD")).toBe(head);
  await expect(readFile(join(f.storefront, "plugins/demo/ORIGIN.md"))).rejects.toThrow();
});
it("refuses symlinks and uncommitted workshop bytes", async () => {
  const f = await fixture();
  await symlink(f.data, join(f.workshop, "packages/demo/escape"));
  expect(
    await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }),
  ).toMatchObject({ status: "blocked" });
  await rm(join(f.workshop, "packages/demo/escape"));
  await write(f.workshop, "packages/demo/same.txt", "uncommitted");
  expect(
    await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }),
  ).toMatchObject({ status: "blocked", reason: "publication-unavailable" });
});
it("records a failed push, retries after restart, then blocks restore", async () => {
  const f = await fixture();
  await git(f.storefront, "remote", "set-url", "origin", join(f.root, "missing.git"));
  const result = await publish(f);
  expect(result).toMatchObject({
    status: "failed",
    receipt: { publication: { state: "committed-not-pushed" }, git: { commit: expect.any(String) } },
  });
  await git(f.storefront, "remote", "set-url", "origin", f.origin);
  const retry = ready(await f.operations.preview({ kind: "retry-push", operationId: result!.receipt.operationId }));
  expect(await f.operations.apply({ planId: retry.planId })).toMatchObject({
    status: "applied",
    receipt: { publication: { state: "pushed" } },
  });
  expect(
    await f.operations.preview({ kind: "restore-import", operationId: result!.receipt.operationId }),
  ).toMatchObject({ status: "blocked", reason: "publication-pushed" });
});
it("restores unpushed publication files with a new local commit", async () => {
  const f = await fixture();
  await git(f.storefront, "remote", "set-url", "origin", join(f.root, "missing.git"));
  const before = await readFile(join(f.storefront, "README.md"), "utf8");
  const result = await publish(f);
  const restore = ready(
    await f.operations.preview({ kind: "restore-import", operationId: result!.receipt.operationId }),
  );
  expect(await f.operations.apply({ planId: restore.planId })).toMatchObject({ status: "applied" });
  expect(await readFile(join(f.storefront, "README.md"), "utf8")).toBe(before);
  await expect(readFile(join(f.storefront, "plugins/demo/ORIGIN.md"))).rejects.toThrow();
  expect(await git(f.storefront, "rev-parse", "HEAD")).not.toBe(result!.receipt.git.commit);
  expect(await f.operations.preview({ kind: "retry-push", operationId: result!.receipt.operationId })).toMatchObject({
    status: "blocked",
  });
});
