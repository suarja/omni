import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import { publicationFixture, git, write, commit } from "../helpers/publication-fixture";
import { createPublicationOperations } from "../../src/main/storefronts/operations";
import type { PreviewMarketplaceResponse } from "../../src/shared/operations-ipc";
import { createPublicationsStore, publicationsFilePath } from "../../src/main/storefronts/publications-store";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const roots: string[] = [];
async function fixture() {
  const f = await publicationFixture();
  roots.push(f.root);
  return f;
}
function ready(response: PreviewMarketplaceResponse) {
  if (response.status !== "ready") throw new Error(response.diagnostic);
  return response.plan;
}
const request = { kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" };
async function publish(f: Awaited<ReturnType<typeof fixture>>) {
  return f.operations.apply({ planId: ready(await f.operations.preview(request)).planId });
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("requires every conflict choice and rejects a choice that introduces a secret", async () => {
  const f = await fixture();
  await publish(f);
  await write(f.workshop, "packages/demo/conflict-a.txt", "sk-abcdefghijklmnopqrstuvwxyz");
  await commit(f.workshop);
  await write(f.storefront, "plugins/demo/conflict-a.txt", "Safe local edit\n");
  const plan = ready(await f.operations.preview(request));
  expect(await f.operations.apply({ planId: plan.planId })).toMatchObject({
    status: "failed",
    receipt: { diagnostic: expect.stringContaining("conflicting") },
  });
  const again = ready(await f.operations.preview(request));
  const head = await git(f.storefront, "rev-parse", "HEAD");
  expect(
    await f.operations.apply({ planId: again.planId, conflictChoices: { "conflict-a.txt": "take-workshop" } }),
  ).toMatchObject({ status: "failed", receipt: { diagnostic: expect.stringContaining("checks") } });
  expect(await git(f.storefront, "rev-parse", "HEAD")).toBe(head);
  expect(await readFile(join(f.storefront, "plugins/demo/conflict-a.txt"), "utf8")).toBe("Safe local edit\n");
});
it("cannot commit unrelated staged work when publishing", async () => {
  const f = await fixture();
  await write(f.storefront, "owner.txt", "Owner work\n");
  await git(f.storefront, "add", "owner.txt");
  expect(await publish(f)).toMatchObject({ status: "applied" });
  expect(await git(f.storefront, "status", "--short")).toContain("A  owner.txt");
  await expect(git(f.storefront, "show", "HEAD:owner.txt")).rejects.toThrow();
});
it("rolls back an interrupted file write and records its backup without committing", async () => {
  const f = await fixture();
  let writes = 0;
  const writer = vi.fn(async (path: string, content: string | Uint8Array) => {
    if (++writes === 2) throw new Error("Injected write failure");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, content);
  });
  const operations = createPublicationOperations({ ...f.options, fileWriter: writer });
  const before = await readFile(join(f.storefront, "README.md"));
  const head = await git(f.storefront, "rev-parse", "HEAD");
  const plan = ready(await operations.preview(request));
  const result = await operations.apply({ planId: plan.planId });
  expect(result).toMatchObject({
    status: "failed",
    receipt: { actions: expect.arrayContaining([expect.objectContaining({ status: "rolled-back" })]) },
  });
  expect(await git(f.storefront, "rev-parse", "HEAD")).toBe(head);
  expect(await readFile(join(f.storefront, "README.md"))).toEqual(before);
});
it("does not push after publication metadata persistence fails", async () => {
  const f = await fixture();
  const push = vi.fn(f.options.git.push);
  const operations = createPublicationOperations({ ...f.options, git: { ...f.options.git, push } });
  const plan = ready(await operations.preview(request));
  const publications = createPublicationsStore(publicationsFilePath(f.data));
  const save = vi.spyOn(publications, "save").mockRejectedValueOnce(new Error("Injected metadata persistence failure"));
  const result = await operations.apply({ planId: plan.planId });
  expect(result).toMatchObject({ status: "failed", receipt: { publication: { state: "committed-not-pushed" } } });
  expect(push).not.toHaveBeenCalled();
  save.mockRestore();
});
it("reloads a failed publication from disk for retry and refuses changed HEAD", async () => {
  const f = await fixture();
  await git(f.storefront, "remote", "set-url", "origin", join(f.root, "missing.git"));
  const result = await publish(f);
  expect(JSON.parse(await readFile(join(f.data, "omni/operations.json"), "utf8")).receipts[0].publication.state).toBe(
    "committed-not-pushed",
  );
  const restarted = createPublicationOperations(f.options);
  await git(f.storefront, "remote", "set-url", "origin", f.origin);
  const retry = ready(await restarted.preview({ kind: "retry-push", operationId: result!.receipt.operationId }));
  await write(f.storefront, "owner.txt", "A later commit\n");
  await commit(f.storefront);
  expect(await restarted.apply({ planId: retry.planId })).toMatchObject({ status: "failed" });
  expect(await f.options.git.headCommit(f.origin)).toBeUndefined();
});
it("refuses changed backups and preserves a previous publication baseline on restore", async () => {
  const f = await fixture();
  await publish(f);
  const publications = createPublicationsStore(publicationsFilePath(f.data));
  const before = await publications.read();
  await write(f.workshop, "packages/demo/same.txt", "Update\n");
  await commit(f.workshop);
  await git(f.storefront, "remote", "set-url", "origin", join(f.root, "missing.git"));
  const result = await publish(f);
  const restore = ready(
    await f.operations.preview({ kind: "restore-import", operationId: result!.receipt.operationId }),
  );
  await write(f.data, `omni/backups/${result!.receipt.operationId}/plugins/demo/same.txt`, "Tampered backup\n");
  expect(await f.operations.apply({ planId: restore.planId })).toMatchObject({ status: "failed" });
  await write(f.data, `omni/backups/${result!.receipt.operationId}/plugins/demo/same.txt`, "base\n");
  const valid = ready(await f.operations.preview({ kind: "restore-import", operationId: result!.receipt.operationId }));
  expect(await f.operations.apply({ planId: valid.planId })).toMatchObject({ status: "applied" });
  expect(await publications.read()).toEqual(before);
});
it("refuses direct agent conversation provenance for publication", async () => {
  const f = await fixture();
  const plan = ready(await f.operations.preview(request));
  expect(
    await f.operations.apply({
      planId: plan.planId,
      provenance: { approval: "conversation", agent: { harness: "codex", requestedAt: "2026-10-12T10:00:00.000Z" } },
    }),
  ).toMatchObject({ status: "failed", receipt: { diagnostic: expect.stringContaining("approval in Omni") } });
});

it.each(["registry", "publications"])("rejects out-of-band %s changes before writing", async (which) => {
  const f = await fixture();
  const plan = ready(await f.operations.preview(request));
  const head = await git(f.storefront, "rev-parse", "HEAD");
  if (which === "registry") {
    const path = "omni/project-source-registry.json";
    const state = JSON.parse(await readFile(join(f.data, path), "utf8"));
    state.sources.find((source: { id: string }) => source.id === "storefront").archivedAt = "2026-10-12T11:00:00.000Z";
    await write(f.data, path, JSON.stringify(state));
  } else await write(f.data, "omni/publications.json", '{"schemaVersion":1,"publications":[]}\n');
  expect(await f.operations.apply({ planId: plan.planId })).toMatchObject({ status: "failed" });
  expect(await git(f.storefront, "rev-parse", "HEAD")).toBe(head);
});

it("does not push if the commit adapter changes a reviewed publication file", async () => {
  const f = await fixture();
  const push = vi.fn(f.options.git.push);
  const gitAdapter = {
    ...f.options.git,
    push,
    commitAll: async (root: string, message: string, paths: readonly string[]) => {
      await write(root, "plugins/demo/same.txt", "Unreviewed bytes\n");
      return f.options.git.commitAll(root, message, paths);
    },
  };
  const operations = createPublicationOperations({ ...f.options, git: gitAdapter });
  const plan = ready(await operations.preview(request));
  expect(await operations.apply({ planId: plan.planId })).toMatchObject({
    status: "failed",
    receipt: { publication: { state: "committed-not-pushed" } },
  });
  expect(push).not.toHaveBeenCalled();
});
