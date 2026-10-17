import { mkdtemp, mkdir, realpath, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { createLocalJsonRegistryStore } from "../../src/adapters/registry/local-json";
import { registerSource } from "../../src/domain/project-source-registry";
import { createOperationStore } from "../../src/main/operation-store";
import { createMarketplaceConnectionOperations } from "../../src/main/operations-connect-marketplace";
import {
  parsePreviewMarketplaceResponse,
  parseApplyOperationResponse,
  parsePreviewOperationRequest,
} from "../../src/shared/operations-ipc";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(git = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-connect-marketplace-")));
  roots.push(root);
  const folder = join(root, "skills");
  await mkdir(folder);
  if (git) execFileSync("git", ["-c", "core.hooksPath=/dev/null", "init", "-q", folder]);
  const registry = createLocalJsonRegistryStore(join(root, "omni/project-source-registry.json"));
  const loaded = await registry.read();
  if (loaded.status !== "ready") throw Error("fixture registry unavailable");
  const decision = registerSource(loaded.state, {
    id: "external",
    ownership: "external",
    displayName: "Own skills",
    canonicalPath: folder,
    createdAt: "2026-10-17T00:00:00.000Z",
  });
  await registry.mutate(0, () => decision.nextState);
  const store = createOperationStore(join(root, "omni/operations.json"));
  const operations = createMarketplaceConnectionOperations({
    userDataPath: root,
    store,
    now: () => Date.parse("2026-10-17T12:00:00Z"),
  });
  return { root, folder, registry, operations, store };
}
it("connects a local external marketplace with a receipt, replay and undo without touching its files", async () => {
  const f = await fixture();
  const request = parsePreviewOperationRequest({ kind: "connect-marketplace", sourceId: "external" });
  const preview = parsePreviewMarketplaceResponse(await f.operations.preview(request as never));
  expect(preview.status).toBe("ready");
  if (preview.status !== "ready") return;
  const result = parseApplyOperationResponse(await f.operations.apply({ planId: preview.plan.planId }));
  expect(result.status).toBe("applied");
  expect(await f.operations.apply({ planId: preview.plan.planId })).toEqual(result);
  const loaded = await f.registry.read();
  expect(loaded).toMatchObject({
    status: "ready",
    state: {
      sources: [
        { id: "external", ownership: "external", archivedAt: expect.any(String) },
        { ownership: "personal", role: "workshop" },
      ],
    },
  });
  const undo = parsePreviewMarketplaceResponse(await f.operations.previewRestore(result.receipt.operationId));
  expect(undo.status).toBe("ready");
  if (undo.status !== "ready") return;
  expect(await f.operations.apply({ planId: undo.plan.planId })).toMatchObject({ status: "applied" });
  expect(await f.registry.read()).toMatchObject({
    state: { sources: [{ id: "external" }, { ownership: "personal", archivedAt: expect.any(String) }] },
  });
  const undone = await f.registry.read();
  if (undone.status !== "ready") throw Error("registry unavailable");
  expect(undone.state.sources[0]).not.toHaveProperty("archivedAt");
  expect(execFileSync("git", ["-C", f.folder, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
});
it("rejects non-Git folders and stale registry or folder identity without changing registrations", async () => {
  const invalid = await fixture(false);
  expect(await invalid.operations.preview({ kind: "connect-marketplace", sourceId: "external" })).toMatchObject({
    status: "blocked",
    reason: "marketplace-not-repository",
  });
  const f = await fixture();
  const preview = await f.operations.preview({ kind: "connect-marketplace", sourceId: "external" });
  if (preview.status !== "ready") throw Error("preview unavailable");
  await rename(f.folder, `${f.folder}-old`);
  await mkdir(f.folder);
  execFileSync("git", ["init", "-q", f.folder]);
  expect(await f.operations.apply({ planId: preview.plan.planId })).toMatchObject({ status: "failed" });
  expect(await f.registry.read()).toMatchObject({ state: { sources: [{ id: "external" }] } });
  const unchanged = await f.registry.read();
  if (unchanged.status !== "ready") throw Error("registry unavailable");
  expect(unchanged.state.sources[0]).not.toHaveProperty("archivedAt");
});

it("reuses the workshop identity after undo and recovery, and blocks recovery when a workshop exists", async () => {
  const f = await fixture();
  const first = await f.operations.preview({ kind: "connect-marketplace", sourceId: "external" });
  if (first.status !== "ready") throw Error("preview failed");
  const applied = await f.operations.apply({ planId: first.plan.planId });
  if (!applied) throw Error("apply failed");
  expect(await f.operations.preview({ kind: "connect-marketplace", sourceId: "external" })).toMatchObject({
    status: "blocked",
    reason: "active-workshop-exists",
  });
  const undo = await f.operations.previewRestore(applied.receipt.operationId);
  if (undo?.status !== "ready") throw Error("undo unavailable");
  await f.operations.apply({ planId: undo.plan.planId });
  const second = await f.operations.preview({ kind: "connect-marketplace", sourceId: "external" });
  if (second.status !== "ready") throw Error("recovery unavailable");
  expect(await f.operations.apply({ planId: second.plan.planId })).toMatchObject({
    status: "applied",
    receipt: { registered: applied.receipt.registered },
  });
  const loaded = await f.registry.read();
  if (loaded.status !== "ready") throw Error("registry unavailable");
  expect(loaded.state.sources.filter((source) => !source.archivedAt && source.ownership === "personal")).toHaveLength(
    1,
  );
  expect(loaded.state.sources).toHaveLength(2);
});
it("rejects a stale registry preview and malformed recovery requests", async () => {
  const f = await fixture();
  const preview = await f.operations.preview({ kind: "connect-marketplace", sourceId: "external" });
  if (preview.status !== "ready") throw Error("preview failed");
  const loaded = await f.registry.read();
  if (loaded.status !== "ready") throw Error("registry unavailable");
  await f.registry.mutate(loaded.state.revision, (state) => ({ ...state, projects: [] }));
  expect(await f.operations.apply({ planId: preview.plan.planId })).toMatchObject({ status: "failed" });
  expect(() =>
    parsePreviewOperationRequest({ kind: "connect-marketplace", sourceId: "external", path: "/arbitrary" }),
  ).toThrow();
  expect(() => parsePreviewOperationRequest({ kind: "connect-marketplace", sourceId: "" })).toThrow();
  expect(await f.operations.preview({ kind: "connect-marketplace", sourceId: "remote:owner/repo" })).toMatchObject({
    status: "blocked",
    reason: "external-folder-unavailable",
  });
});
