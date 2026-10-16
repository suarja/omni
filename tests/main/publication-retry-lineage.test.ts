import { createOperationStore } from "../../src/main/operation-store";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publicationFixture, git, write } from "../helpers/publication-fixture";
import { createPublicationOperations } from "../../src/main/storefronts/operations";
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
  await git(f.storefront, "remote", "set-url", "origin", join(f.root, "missing.git"));
  const original = await f.operations.apply({
    planId: ready(await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" }))
      .planId,
  });
  if (!original) throw new Error("Missing fixture receipt.");
  return { ...f, original: original.receipt };
}
async function restart(f: Awaited<ReturnType<typeof fixture>>) {
  const userDataPath = join(f.root, "restarted-profile");
  for (const file of ["project-source-registry.json", "publications.json", "operations.json"])
    await write(userDataPath, `omni/${file}`, await readFile(join(f.data, "omni", file)));
  return createPublicationOperations({
    ...f.options,
    userDataPath,
    operationStore: createOperationStore(join(userDataPath, "omni/operations.json")),
  });
}
async function retry(f: Awaited<ReturnType<typeof fixture>>, receipt: OperationReceipt, operations = f.operations) {
  return operations.apply({
    planId: ready(await operations.preview({ kind: "retry-push", operationId: receipt.operationId })).planId,
  });
}
it("blocks recovery across the entire retry lineage after a retry of a failed retry succeeds", async () => {
  const f = await fixture();
  const failedRetry = await retry(f, f.original);
  expect(failedRetry).toMatchObject({ status: "failed", receipt: { publication: { state: "committed-not-pushed" } } });
  await git(f.storefront, "remote", "set-url", "origin", f.origin);
  const restarted = createPublicationOperations(f.options);
  const pushed = await retry(f, failedRetry!.receipt, restarted);
  expect(pushed).toMatchObject({ status: "applied", receipt: { publication: { state: "pushed" } } });
  const again = await restart(f);
  for (const receipt of [f.original, failedRetry!.receipt, pushed!.receipt]) {
    expect(await again.preview({ kind: "restore-import", operationId: receipt.operationId })).toMatchObject({
      status: "blocked",
      reason: "publication-pushed",
    });
    expect(await again.preview({ kind: "retry-push", operationId: receipt.operationId })).toMatchObject({
      status: "blocked",
      reason: "publication-pushed",
    });
  }
});
it("persists new pushed evidence before trying to update an earlier receipt that fails", async () => {
  const f = await fixture();
  const failedRetry = await retry(f, f.original);
  await git(f.storefront, "remote", "set-url", "origin", f.origin);
  const attempts: string[] = [];
  const operationStore = {
    ...f.store,
    append: async (receipt: OperationReceipt) => {
      attempts.push(receipt.operationId);
      if (receipt.operationId === failedRetry!.receipt.operationId && receipt.publication?.state === "pushed")
        throw new Error("Injected earlier receipt save failure");
      return f.store.append(receipt);
    },
  };
  const operations = createPublicationOperations({ ...f.options, operationStore });
  const result = await retry(f, failedRetry!.receipt, operations);
  expect(result?.receipt.publication?.state).toBe("pushed");
  expect(attempts[0]).toBe(result?.receipt.operationId);
  const onDisk = JSON.parse(await readFile(join(f.data, "omni/operations.json"), "utf8")) as {
    receipts: OperationReceipt[];
  };
  expect(
    onDisk.receipts.find((receipt) => receipt.operationId === result?.receipt.operationId)?.publication?.state,
  ).toBe("pushed");
  expect(
    onDisk.receipts.find((receipt) => receipt.operationId === failedRetry!.receipt.operationId)?.publication?.state,
  ).toBe("committed-not-pushed");
  const restarted = await restart(f);
  for (const receipt of [f.original, failedRetry!.receipt])
    expect(await restarted.preview({ kind: "restore-import", operationId: receipt.operationId })).toMatchObject({
      status: "blocked",
      reason: "publication-pushed",
    });
});
it("validates root publication files when retrying a failed retry receipt", async () => {
  const f = await fixture();
  const failedRetry = await retry(f, f.original);
  const { write } = await import("../helpers/publication-fixture");
  await write(f.storefront, "plugins/demo/same.txt", "Changed after retry\n");
  expect(
    await createPublicationOperations(f.options).preview({
      kind: "retry-push",
      operationId: failedRetry!.receipt.operationId,
    }),
  ).toMatchObject({ status: "blocked" });
});

it.each(["missing", "cycle"])("blocks a %s retry ancestry without pushing", async (failure) => {
  const f = await fixture();
  const retryResult = await retry(f, f.original);
  const loaded = await f.store.read();
  if (loaded.status !== "ready") throw new Error("Missing fixture receipts");
  const broken = {
    ...retryResult!.receipt,
    publication: {
      ...retryResult!.receipt.publication!,
      retryOf: failure === "cycle" ? retryResult!.receipt.operationId : "missing-receipt",
    },
  };
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
      read: async () => ({
        status: "ready",
        receipts: [broken, ...loaded.receipts.filter((receipt) => receipt.operationId !== broken.operationId)],
      }),
    },
  });
  expect(await operations.preview({ kind: "retry-push", operationId: broken.operationId })).toMatchObject({
    status: "blocked",
    reason: "publication-recovery-unavailable",
  });
  expect(pushes).toBe(0);
});
