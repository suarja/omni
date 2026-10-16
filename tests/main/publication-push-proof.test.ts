import { cp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publicationFixture, git, write } from "../helpers/publication-fixture";
import { createPublicationOperations } from "../../src/main/storefronts/operations";
import { createOperationStore } from "../../src/main/operation-store";
import type { OperationReceipt, PreviewMarketplaceResponse } from "../../src/shared/operations-ipc";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function ready(value: PreviewMarketplaceResponse) {
  if (value.status !== "ready") throw new Error(value.diagnostic);
  return value.plan;
}
async function fixture() {
  const f = await publicationFixture();
  roots.push(f.root);
  return f;
}
async function restart(f: Awaited<ReturnType<typeof fixture>>) {
  const userDataPath = join(f.root, "restart-profile");
  for (const file of ["project-source-registry.json", "publications.json", "operations.json"]) {
    try {
      await write(userDataPath, `omni/${file}`, await readFile(join(f.data, "omni", file)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    await cp(join(f.data, "omni/backups"), join(userDataPath, "omni/backups"), { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return createPublicationOperations({
    ...f.options,
    userDataPath,
    operationStore: createOperationStore(join(userDataPath, "omni/operations.json")),
  });
}
function rejectPushedProof(f: Awaited<ReturnType<typeof fixture>>) {
  return createPublicationOperations({
    ...f.options,
    operationStore: {
      ...f.store,
      append: async (receipt: OperationReceipt) => {
        if (receipt.publication?.state === "pushed") throw new Error("Injected first pushed proof save failure");
        return f.store.append(receipt);
      },
    },
  });
}
it.each(["publish", "retry", "create"])(
  "closes restore after %s reaches origin but its first pushed proof cannot be saved",
  async (kind) => {
    const f = await fixture();
    const aliases: OperationReceipt[] = [];
    if (kind === "retry") {
      await git(f.storefront, "remote", "set-url", "origin", join(f.root, "missing.git"));
      const original = await f.operations.apply({
        planId: ready(
          await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }),
        ).planId,
      });
      aliases.push(original!.receipt);
      const failed = await f.operations.apply({
        planId: ready(await f.operations.preview({ kind: "retry-push", operationId: original!.receipt.operationId }))
          .planId,
      });
      aliases.push(failed!.receipt);
      await git(f.storefront, "remote", "set-url", "origin", f.origin);
    }
    const operations = rejectPushedProof(f);
    const request =
      kind === "create"
        ? {
            kind: "create-storefront" as const,
            name: "public-plugins",
            license: "MIT" as const,
            login: "fixture",
            repositoryUrl: f.origin,
          }
        : kind === "retry"
          ? { kind: "retry-push" as const, operationId: aliases.at(-1)!.operationId }
          : { kind: "publish-plugin" as const, pluginId: "demo", storefrontId: "storefront" };
    const result = await operations.apply({ planId: ready(await operations.preview(request)).planId });
    expect(result).toMatchObject({
      status: "failed",
      receipt: { publication: { state: "push-outcome-unknown" }, diagnostic: expect.stringContaining("receipt") },
    });
    const root = kind === "create" ? join(f.root, "public-plugins") : f.storefront;
    const head = await git(root, "rev-parse", "HEAD");
    expect(await git(f.origin, "rev-parse", "refs/heads/main")).toBe(head);
    const loaded = await f.store.read();
    if (loaded.status !== "ready") throw new Error("Missing receipts");
    const uncertain = loaded.receipts.find((receipt) => receipt.operationId === result!.receipt.operationId)!;
    expect(uncertain.publication?.state).toBe("push-outcome-unknown");
    aliases.push(uncertain);
    const restarted = await restart(f);
    for (const receipt of aliases) {
      expect(await restarted.preview({ kind: "restore-import", operationId: receipt.operationId })).toMatchObject({
        status: "blocked",
        reason: "publication-push-uncertain",
      });
    }
    const retryPlan = ready(await restarted.preview({ kind: "retry-push", operationId: uncertain.operationId }));
    await git(root, "remote", "set-url", "origin", join(f.root, "missing.git"));
    expect(await restarted.apply({ planId: retryPlan.planId })).toMatchObject({ status: "failed" });
    await git(root, "remote", "set-url", "origin", f.origin);
    const pushed = await restarted.apply({
      planId: ready(await restarted.preview({ kind: "retry-push", operationId: uncertain.operationId })).planId,
    });
    expect(pushed).toMatchObject({ status: "applied", receipt: { publication: { state: "pushed" } } });
    expect(await git(root, "rev-parse", "HEAD")).toBe(head);
    for (const receipt of aliases)
      expect(await restarted.preview({ kind: "restore-import", operationId: receipt.operationId })).toMatchObject({
        status: "blocked",
        reason: "publication-pushed",
      });
  },
);
it("does not push if conservative evidence cannot be saved", async () => {
  const f = await fixture();
  let pushes = 0;
  const operations = createPublicationOperations({
    ...f.options,
    git: {
      ...f.options.git,
      push: async () => {
        pushes++;
        throw new Error("Unexpected push");
      },
    },
    operationStore: {
      ...f.store,
      append: async (receipt) => {
        if (receipt.publication?.state === "push-outcome-unknown") throw new Error("Injected pre-push save failure");
        return f.store.append(receipt);
      },
    },
  });
  expect(
    await operations.apply({
      planId: ready(await operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }))
        .planId,
    }),
  ).toMatchObject({ status: "failed" });
  expect(pushes).toBe(0);
});
it("keeps a confirmed unreachable push restorable and retryable after restart", async () => {
  const f = await fixture();
  await git(f.storefront, "remote", "set-url", "origin", join(f.root, "missing.git"));
  const failed = await f.operations.apply({
    planId: ready(await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }))
      .planId,
  });
  expect(failed?.receipt.publication?.state).toBe("committed-not-pushed");
  const restarted = await restart(f);
  expect(await restarted.preview({ kind: "restore-import", operationId: failed!.receipt.operationId })).toMatchObject({
    status: "ready",
  });
  expect(await restarted.preview({ kind: "retry-push", operationId: failed!.receipt.operationId })).toMatchObject({
    status: "ready",
  });
});
it("preserves the pre-push marker when every post-push receipt save fails", async () => {
  const f = await fixture();
  let completed = false;
  const operations = createPublicationOperations({
    ...f.options,
    git: {
      ...f.options.git,
      push: async (...args) => {
        const result = await f.options.git.push(...args);
        completed = true;
        return result;
      },
    },
    operationStore: {
      ...f.store,
      append: async (receipt) => {
        if (completed) throw new Error("Injected all post-push receipt saves failure");
        return f.store.append(receipt);
      },
    },
  });
  const result = await operations.apply({
    planId: ready(await operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }))
      .planId,
  });
  expect(result).toMatchObject({
    status: "failed",
    receipt: { diagnostic: expect.stringContaining("Push completed") },
  });
  expect(await git(f.origin, "rev-parse", "refs/heads/main")).toBe(result!.receipt.git.commit);
  expect(
    await (await restart(f)).preview({ kind: "restore-import", operationId: result!.receipt.operationId }),
  ).toMatchObject({ status: "blocked", reason: "publication-push-uncertain" });
});
it("keeps uncertain lineage closed when a subsequent reviewed retry has a confirmed failure", async () => {
  const f = await fixture();
  const operations = createPublicationOperations({
    ...f.options,
    git: {
      ...f.options.git,
      push: async (...args) => {
        await f.options.git.push(...args);
        throw new Error("Injected lost push response");
      },
    },
  });
  const original = await operations.apply({
    planId: ready(await operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }))
      .planId,
  });
  expect(original!.receipt.publication?.state).toBe("push-outcome-unknown");
  expect(await git(f.origin, "rev-parse", "refs/heads/main")).toBe(original!.receipt.git.commit);
  await git(f.storefront, "remote", "set-url", "origin", join(f.root, "missing.git"));
  const restarted = await restart(f);
  const failed = await restarted.apply({
    planId: ready(await restarted.preview({ kind: "retry-push", operationId: original!.receipt.operationId })).planId,
  });
  expect(failed!.receipt.publication?.state).toBe("committed-not-pushed");
  for (const receipt of [original!.receipt, failed!.receipt])
    expect(await restarted.preview({ kind: "restore-import", operationId: receipt.operationId })).toMatchObject({
      status: "blocked",
      reason: "publication-push-uncertain",
    });
  await write(f.storefront, "plugins/demo/same.txt", "Concurrent local edit\n");
  expect(await restarted.preview({ kind: "retry-push", operationId: failed!.receipt.operationId })).toMatchObject({
    status: "blocked",
  });
});
