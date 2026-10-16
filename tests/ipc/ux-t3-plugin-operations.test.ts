import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { setup, invoke } from "./operations-import-helpers";
import {
  parsePreviewMarketplaceResponse,
  parseApplyOperationResponse,
  type OperationPlan,
  OPERATIONS_IPC_CHANNELS as channels,
} from "../../src/shared/operations-ipc";

async function preview(request: unknown): Promise<OperationPlan> {
  const result = parsePreviewMarketplaceResponse(await invoke(channels.preview, request));
  expect(result.status, JSON.stringify(result)).toBe("ready");
  if (result.status !== "ready") throw new Error(result.diagnostic);
  return result.plan;
}

it("requires a description for a new plugin and writes it to both projected manifests", async () => {
  const fixture = await setup();
  const manifestPath = join(fixture.marketplace, "omni.marketplace.json");
  await writeFile(
    manifestPath,
    JSON.stringify({ ...JSON.parse(await readFile(manifestPath, "utf8")), visibility: "public" }),
  );
  await mkdir(join(fixture.marketplace, ".claude-plugin"));
  await writeFile(
    join(fixture.marketplace, ".claude-plugin/marketplace.json"),
    JSON.stringify({ name: "personal", plugins: [] }),
  );
  const request = {
    kind: "import-artifact",
    source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
    relativePath: "skills/review",
    target: { newPackageName: "build-to-show" },
  };
  await expect(invoke(channels.preview, request)).rejects.toThrow(/description/i);
  const plan = await preview({
    ...request,
    target: { ...request.target, description: "Build posts and demos from shipped work." },
  });
  expect(await invoke(channels.apply, { planId: plan.planId })).toMatchObject({ status: "applied" });
  const plugin = JSON.parse(
    await readFile(join(fixture.marketplace, "packages/build-to-show/.claude-plugin/plugin.json"), "utf8"),
  );
  const marketplace = JSON.parse(await readFile(join(fixture.marketplace, ".claude-plugin/marketplace.json"), "utf8"));
  expect(plugin.description).toBe("Build posts and demos from shipped work.");
  expect(marketplace.plugins[0].description).toBe(plugin.description);
  expect(JSON.parse(await readFile(manifestPath, "utf8")).visibility).toBe("public");
});

it("describes a plugin in both files and restores their exact bytes", async () => {
  const fixture = await setup();
  await mkdir(join(fixture.marketplace, ".claude-plugin"));
  await mkdir(join(fixture.marketplace, "packages/tools/.claude-plugin"));
  const paths = ["packages/tools/.claude-plugin/plugin.json", ".claude-plugin/marketplace.json"];
  const bytes = [
    Buffer.from('{ "name": "tools", "custom": 1 }\r\n'),
    Buffer.from('{"name":"personal","plugins":[{"name":"tools","source":"./packages/tools"}]}\n'),
  ];
  await Promise.all(paths.map((path, i) => writeFile(join(fixture.marketplace, path), bytes[i]!)));
  const plan = await preview({
    kind: "describe-plugin",
    packageId: "packages/tools",
    description: "Tools for reviewing changes.",
  });
  const result = parseApplyOperationResponse(await invoke(channels.apply, { planId: plan.planId }));
  expect(result.status).toBe("applied");
  expect(result.receipt.git.commit).toMatch(/^[a-f0-9]+$/);
  expect(JSON.parse(await readFile(join(fixture.marketplace, paths[0]!), "utf8"))).toMatchObject({
    custom: 1,
    description: "Tools for reviewing changes.",
  });
  expect(JSON.parse(await readFile(join(fixture.marketplace, paths[1]!), "utf8")).plugins[0].description).toBe(
    "Tools for reviewing changes.",
  );
  const restore = await preview({
    kind: "restore-import",
    operationId: result.receipt.operationId,
  });
  expect(await invoke(channels.apply, { planId: restore.planId })).toMatchObject({ status: "applied" });
  expect(await Promise.all(paths.map((path) => readFile(join(fixture.marketplace, path))))).toEqual(bytes);
});

it("keeps edits made after a description preview and refuses a changed restore backup", async () => {
  const fixture = await setup();
  const path = "packages/tools/omni.plugin.json";
  const plan = await preview({ kind: "describe-plugin", packageId: "packages/tools", description: "Review tools." });
  const before = await readFile(join(fixture.marketplace, path));
  await writeFile(join(fixture.marketplace, path), `${before.toString("utf8")}\n`);
  const retained = await readFile(join(fixture.marketplace, path));
  expect(await invoke(channels.apply, { planId: plan.planId })).toMatchObject({ status: "failed" });
  expect(await readFile(join(fixture.marketplace, path))).toEqual(retained);
  const fresh = await preview({ kind: "describe-plugin", packageId: "packages/tools", description: "Review tools." });
  const applied = parseApplyOperationResponse(await invoke(channels.apply, { planId: fresh.planId }));
  expect(applied.status).toBe("applied");
  await writeFile(join(fixture.userDataPath, "omni/backups", applied.receipt.operationId, path), "tampered backup");
  expect(
    await invoke(channels.preview, { kind: "restore-import", operationId: applied.receipt.operationId }),
  ).toMatchObject({ status: "blocked", reason: "restore-backup-changed" });
});

it("describes and restores a plugin without committing when the Git switch is off", async () => {
  const fixture = await setup();
  const { createSettingsStore, settingsFilePath } = await import("../../src/main/settings-store");
  const store = createSettingsStore(settingsFilePath(fixture.userDataPath));
  const settings = await store.read();
  await store.set({
    commitChanges: false,
    agents: { approval: settings.agents.approval, guard: settings.agents.guard },
    ai: settings.ai,
    features: settings.features,
    externalLibrary: settings.externalLibrary,
  });
  const plan = await preview({ kind: "describe-plugin", packageId: "packages/tools", description: "Review tools." });
  expect(plan.git.mode).toBe("disabled");
  const applied = parseApplyOperationResponse(await invoke(channels.apply, { planId: plan.planId }));
  expect(applied.receipt.git.commit).toBeUndefined();
  const restore = await preview({ kind: "restore-import", operationId: applied.receipt.operationId });
  expect(restore.git.mode).toBe("disabled");
  expect(await invoke(channels.apply, { planId: restore.planId })).toMatchObject({ status: "applied" });
});
