import { cp, mkdir, mkdtemp, rm, readFile, rename } from "node:fs/promises";
import { persistWorkshopReceipt } from "../../src/main/workshop-delivery/receipt";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLocalJsonRegistryStore } from "../../src/adapters/registry/local-json";
import { registerSource } from "../../src/domain/project-source-registry";
import { createWriteSkillOperations } from "../../src/main/operations-write-skill";
import { createRestoreOperations } from "../../src/main/operations-restore";
import { createOperationStore } from "../../src/main/operation-store";
import { systemGitCli } from "../../src/main/git-cli";
import { runGitCommand as git } from "../../src/main/git-command";
import { readWorkshopDelivery } from "../../src/main/workshop-delivery/service";
import { createWorkshopDeliveryOperations } from "../../src/main/workshop-delivery/operations";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omni-workshop-delivery-"));
  roots.push(root);
  const userDataPath = join(root, "profile"),
    workshop = join(root, "workshop"),
    remote = join(root, "remote.git");
  await mkdir(workshop);
  await cp(join(import.meta.dirname, "../fixtures/make-compatible/claude-only"), workshop, { recursive: true });
  await git(workshop, ["init", "-b", "main"]);
  await git(workshop, ["config", "user.name", "Example"]);
  await git(workshop, ["config", "user.email", "ada@example.com"]);
  await git(workshop, ["add", "."]);
  await git(workshop, ["commit", "-m", "fixture"]);
  await git(root, ["init", "--bare", remote]);
  await git(workshop, ["remote", "add", "origin", remote]);
  await git(workshop, ["push", "--set-upstream", "origin", "main"]);
  const registry = createLocalJsonRegistryStore(join(userDataPath, "omni/project-source-registry.json"));
  await registry.mutate(
    0,
    (state) =>
      registerSource(state, {
        id: "workshop",
        displayName: "Workshop",
        canonicalPath: workshop,
        ownership: "personal",
        role: "workshop",
        createdAt: "2026-10-22T00:00:00.000Z",
      }).nextState,
  );
  const operationStore = createOperationStore(join(userDataPath, "omni/operations.json"));
  const options = { userDataPath, operationStore, git: systemGitCli };
  const operations = createWriteSkillOperations(options);
  const read = () =>
    readWorkshopDelivery({
      userDataPath,
      home: root,
      operationStore,
      readDrift: async () => ({ status: "ready", bindings: [] }),
    });
  const delivery = createWorkshopDeliveryOperations({ userDataPath, home: root, operationStore, read });
  const apply = async () => {
    const preview = await operations.preview({
      kind: "write-skill",
      sourceId: "workshop",
      packageId: "packages/skills-only",
      mode: "create",
      folderName: "f6-proof",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: f6-proof\ndescription: Use for synthetic workshop delivery proof.\n---\n\n# F6 proof\n",
        },
      ],
    });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    return operations.apply({ planId: preview.plan.planId });
  };
  return { root, userDataPath, workshop, remote, options, operationStore, read, delivery, apply };
}
it("pushes a real approved skill write and its earlier unpushed commit, then restores with a forward commit", async () => {
  const f = await fixture();
  await git(f.workshop, ["commit", "--allow-empty", "-m", "Earlier local change"]);
  const result = await f.apply();
  expect(result?.status).toBe("applied");
  expect(result?.receipt.workshopPush?.status).toBe("pushed");
  expect(await git(f.remote, ["rev-parse", "main"])).toBe(result?.receipt.git.commit);
  const restore = createRestoreOperations(f.options),
    preview = await restore.preview({ kind: "restore-import", operationId: result!.receipt.operationId });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  const undone = await restore.apply({ planId: preview.plan.planId });
  expect(undone?.receipt.workshopPush?.status).toBe("pushed");
  expect(
    await git(f.workshop, ["merge-base", "--is-ancestor", result!.receipt.git.commit!, undone!.receipt.git.commit!]),
  ).toBe("");
});
it("retains a failed push across a new delivery service and retries through a new approved receipt", async () => {
  const f = await fixture();
  await git(f.workshop, ["remote", "set-url", "--push", "origin", join(f.root, "missing.git")]);
  const result = await f.apply();
  expect(result?.status).toBe("applied");
  expect(result?.receipt.workshopPush?.status).toBe("failed");
  expect(await readFile(join(f.workshop, "packages/skills-only/skills/f6-proof/SKILL.md"), "utf8")).toContain(
    "F6 proof",
  );
  const persisted = JSON.parse(await readFile(join(f.userDataPath, "omni/operations.json"), "utf8"));
  expect(persisted.receipts[0].workshopPush.status).toBe("failed");
  expect((await f.read()).workshop?.sync.status).toBe("push-failed");
  await git(f.workshop, ["remote", "set-url", "--push", "origin", f.remote]);
  const preview = await f.delivery.preview({ kind: "retry-workshop-push", sourceId: "workshop" });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  const retried = await f.delivery.apply({ planId: preview.plan.planId });
  expect(retried?.receipt.workshopPush?.status).toBe("pushed");
  expect((await f.read()).workshop?.sync.status).toBe("current");
  expect(await git(f.remote, ["rev-parse", "main"])).toBe(result?.receipt.git.commit);
});
it("counts unpushed commits from the confirmed destination instead of a stale tracking ref while offline", async () => {
  const f = await fixture();
  await f.apply();
  await git(f.workshop, ["commit", "--allow-empty", "-m", "Next local change"]);
  const commit = await git(f.workshop, ["rev-parse", "HEAD"]);
  await rename(f.remote, `${f.remote}.offline`);
  const receipt = await persistWorkshopReceipt(
    {
      operationId: "offline-count",
      kind: "write-skill",
      status: "applied",
      appliedAt: new Date().toISOString(),
      displayTarget: "Workshop",
      actions: [],
      git: { mode: "commit", commit },
      registered: { sourceId: "workshop" },
    },
    f.workshop,
    f.options,
  );
  expect(receipt.workshopPush).toMatchObject({ status: "failed", ahead: 1, behind: 0 });
  expect((await f.read()).workshop?.sync).toMatchObject({ status: "push-failed", ahead: 1, behind: 0 });
});
it("keeps the latest restored push as the offline count baseline", async () => {
  const f = await fixture();
  const result = await f.apply();
  const restore = createRestoreOperations(f.options);
  const preview = await restore.preview({ kind: "restore-import", operationId: result!.receipt.operationId });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  const restored = await restore.apply({ planId: preview.plan.planId });
  expect(restored?.receipt.workshopPush?.status).toBe("pushed");
  await git(f.workshop, ["commit", "--allow-empty", "-m", "Pending after restore"]);
  await rename(f.remote, `${f.remote}.offline`);
  expect((await f.read()).workshop?.sync).toMatchObject({ status: "unavailable", ahead: 1, behind: 0 });
});
