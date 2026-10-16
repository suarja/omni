import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import { publicationFixture } from "../helpers/publication-fixture";
import { createRegistryView } from "../../src/domain/project-source-registry";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { expectAgentStoresToReload } from "../helpers/agent-store-reload";
import { createAgentRouter } from "../../src/main/agent-gateway/router";
import { createSettingsStore, settingsFilePath } from "../../src/main/settings-store";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock("electron", () => ({ app: { getVersion: () => "fixture" } }));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const f = await publicationFixture();
  roots.push(f.root);
  const requests = createAgentRequestsStore(join(f.data, "omni/agent-requests.json"));
  const router = createAgentRouter({
    userDataPath: f.data,
    requests,
    operationStore: f.store,
    registry: {
      listRegistry: async () => {
        const loaded = await f.registry.read();
        if (loaded.status !== "ready") throw new Error("Unavailable fixture");
        return { status: "ready", registry: createRegistryView(loaded.state) };
      },
      observeRegisteredEntry: async () => ({
        status: "observed",
        observation: { inventory: { displayRoot: "Workshop", packages: [], artifacts: [] } },
      }),
    } as never,
    operations: { previewOperation: f.operations.preview, applyOperation: f.operations.apply } as never,
    bindings: {} as never,
    settingsStore: createSettingsStore(settingsFilePath(f.data)),
  });
  return { ...f, requests, router };
}
it("persists a pending public-publication request and waits without any storefront write", async () => {
  const f = await fixture();
  const before = await readFile(join(f.storefront, "README.md"));
  const preview = (await f.router.handle(
    "preview_publish",
    { pluginId: "demo", storefrontId: "storefront" },
    { name: "test", version: "1", harness: "codex" },
  )) as { requestId: string };
  expect(await f.requests.get(preview.requestId)).toMatchObject({
    approval: "omni",
    approvalReason: { code: "public-publication" },
    status: "pending",
    plan: { publication: { conflicts: [], findings: [] } },
  });
  expect(
    await f.router.handle("apply", { requestId: preview.requestId, waitMs: 0 }, { name: "test", version: "1" }),
  ).toMatchObject({ status: "pending", approvalReason: { code: "public-publication" } });
  expect(await readFile(join(f.storefront, "README.md"))).toEqual(before);
  const reloaded = createAgentRequestsStore(join(f.data, "omni/agent-requests.json"));
  expect(await reloaded.get(preview.requestId)).toMatchObject({
    request: { kind: "publish-plugin" },
    plan: { publication: { files: expect.any(Array) } },
  });
  await expectAgentStoresToReload(f.data);
});
it("reports workshop and storefront roles, GitHub identity and publication counts", async () => {
  const f = await fixture();
  const status = await f.router.handle("status", {}, { name: "test", version: "1" });
  expect(status).toMatchObject({
    workshop: { id: "workshop", role: "workshop", githubRepository: "fixture/workshop" },
    storefronts: [{ id: "storefront", role: "storefront", drift: { status: "ready", toPublish: 0, conflicts: 0 } }],
  });
  expect(await f.router.handle("list_marketplace", {}, { name: "test", version: "1" })).toMatchObject({
    workshop: { role: "workshop" },
    storefronts: [{ role: "storefront" }],
  });
});

it("reloads the completed publication request and its durable receipt", async () => {
  const f = await fixture();
  const client = { name: "test", version: "1", harness: "codex" as const };
  const preview = (await f.router.handle(
    "preview_publish",
    { pluginId: "demo", storefrontId: "storefront" },
    client,
  )) as { requestId: string };
  await expectAgentStoresToReload(f.data);
  const refreshed = await f.router.refreshAgentRequest(preview.requestId);
  if (refreshed.plan.kind === "assign") throw new Error("Publication preview is unavailable.");
  const lease = await f.requests.acquireApplyAuthorization(preview.requestId);
  const applied = await f.operations.apply({ planId: refreshed.plan.planId, provenance: { approval: "omni" } });
  expect(applied?.status).toBe("applied");
  if (!applied) throw new Error("Publication receipt is unavailable.");
  await f.requests.recordApplyOutcome(
    preview.requestId,
    [applied.receipt.operationId],
    { status: "applied" },
    { mode: "omni", at: lease.approvedAt, harness: "codex" },
    lease.leaseId,
  );
  await expectAgentStoresToReload(f.data);
});
