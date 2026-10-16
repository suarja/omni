import { createRegistryView } from "../../src/domain/project-source-registry";
import { readAgentStorefronts } from "../../src/main/agent-gateway/router-storefronts";
import { chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publicationFixture, git, write, commit } from "../helpers/publication-fixture";
import { createPublicationOperations } from "../../src/main/storefronts/operations";
import { samePlan } from "../../src/shared/agent-plan-freshness";
import { inspectStorefrontFolder } from "../../src/main/storefronts/inspection";
import type { PreviewMarketplaceResponse } from "../../src/shared/operations-ipc";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const f = await publicationFixture();
  roots.push(f.root);
  return f;
}
function ready(result: PreviewMarketplaceResponse) {
  if (result.status !== "ready") throw new Error(result.diagnostic);
  return result.plan;
}
const request = { kind: "publish-plugin" as const, pluginId: "demo", storefrontId: "storefront" };
it.each(["publish", "retry", "create"])(
  "closes restore when %s receives a nonzero push result after the remote accepted the commit",
  async (kind) => {
    const f = await fixture();
    let originalId: string | undefined;
    if (kind === "retry") {
      await git(f.storefront, "remote", "set-url", "origin", join(f.root, "missing.git"));
      const original = await f.operations.apply({ planId: ready(await f.operations.preview(request)).planId });
      originalId = original!.receipt.operationId;
      await git(f.storefront, "remote", "set-url", "origin", f.origin);
    }
    const wrapper = join(f.root, "receive-error.sh");
    await write(
      f.root,
      "receive-error.sh",
      '#!/bin/sh\ngit-receive-pack "$@"\nprintf "Injected lost acknowledgement\\n" >&2\nexit 1\n',
    );
    await chmod(wrapper, 0o755);
    const options =
      kind === "create"
        ? {
            ...f.options,
            git: {
              ...f.options.git,
              push: async (...args: Parameters<typeof f.options.git.push>) => {
                await git(args[0], "config", "remote.origin.receivepack", wrapper);
                return f.options.git.push(...args);
              },
            },
          }
        : f.options;
    if (kind !== "create") await git(f.storefront, "config", "remote.origin.receivepack", wrapper);
    const operations = createPublicationOperations(options);
    const previewRequest =
      kind === "create"
        ? {
            kind: "create-storefront" as const,
            name: "public-plugins",
            license: "MIT" as const,
            login: "fixture",
            repositoryUrl: f.origin,
          }
        : kind === "retry"
          ? { kind: "retry-push" as const, operationId: originalId! }
          : request;
    const result = await operations.apply({ planId: ready(await operations.preview(previewRequest)).planId });
    expect(await git(f.origin, "rev-parse", "refs/heads/main")).toBe(result!.receipt.git.commit);
    expect(result).toMatchObject({
      status: "failed",
      receipt: {
        publication: { state: "pushed" },
        diagnostic: expect.stringContaining("Injected lost acknowledgement"),
      },
    });
    const restarted = createPublicationOperations(f.options);
    for (const operationId of [result!.receipt.operationId, ...(originalId ? [originalId] : [])])
      expect(await restarted.preview({ kind: "restore-import", operationId })).toMatchObject({
        status: "blocked",
        reason: "publication-pushed",
      });
  },
);
it("retains uncertainty when a published remote is inaccessible during outcome proof", async () => {
  const f = await fixture();
  const moved = join(f.root, "received.git");
  const wrapper = join(f.root, "receive-move.sh");
  await write(f.root, "receive-move.sh", '#!/bin/sh\ngit-receive-pack "$@"\nmv "$1" "' + moved + '"\nexit 1\n');
  await chmod(wrapper, 0o755);
  await git(f.storefront, "config", "remote.origin.receivepack", wrapper);
  const result = await f.operations.apply({ planId: ready(await f.operations.preview(request)).planId });
  expect(await git(moved, "rev-parse", "refs/heads/main")).toBe(result!.receipt.git.commit);
  expect(result!.receipt.publication?.state).toBe("push-outcome-unknown");
  expect(
    await createPublicationOperations(f.options).preview({
      kind: "restore-import",
      operationId: result!.receipt.operationId,
    }),
  ).toMatchObject({ status: "blocked", reason: "publication-push-uncertain" });
});
it("rejects stale consent when the effective pushurl changes and identifies its new destination", async () => {
  const f = await fixture();
  const other = join(f.root, "other.git");
  await git(f.root, "init", "--bare", other);
  const before = ready(await f.operations.preview(request));
  await git(f.storefront, "config", "remote.origin.pushurl", other);
  const after = ready(await f.operations.preview(request));
  expect(samePlan(before, after)).toBe(false);
  expect(await f.operations.apply({ planId: before.planId })).toMatchObject({ status: "failed" });
  expect(await git(other, "show-ref", "--heads").catch(() => "")).toBe("");
  const result = await f.operations.apply({ planId: after.planId });
  expect(result).toMatchObject({ status: "applied", receipt: { publication: { remoteUrl: other } } });
  expect(await git(other, "rev-parse", "refs/heads/main")).toBe(result!.receipt.git.commit);
  expect(await git(f.origin, "show-ref", "--heads").catch(() => "")).toBe("");
  expect(await readFile(join(f.storefront, "plugins/demo/ORIGIN.md"), "utf8")).toContain("fixture/workshop");
});
it.each(["insteadOf", "pushInsteadOf"])("binds publication to Git's effective %s destination", async (rewrite) => {
  const f = await fixture();
  const other = join(f.root, "other.git");
  await git(f.root, "init", "--bare", other);
  await git(f.storefront, "config", `url.${other}.${rewrite}`, f.origin);
  const first = ready(await f.operations.preview(request));
  await git(f.storefront, "config", `url.${other}.${rewrite}`, join(f.root, "unmatched.git"));
  expect(samePlan(first, ready(await f.operations.preview(request)))).toBe(false);
  await git(f.storefront, "config", `url.${other}.${rewrite}`, f.origin);
  const result = await f.operations.apply({ planId: ready(await f.operations.preview(request)).planId });
  expect(result!.receipt.publication?.remoteUrl).toBe(other);
  expect(await git(other, "rev-parse", "refs/heads/main")).toBe(result!.receipt.git.commit);
});
it("blocks multiple push destinations without broadcasting", async () => {
  const f = await fixture();
  const other = join(f.root, "other.git");
  await git(f.root, "init", "--bare", other);
  await git(f.storefront, "config", "--add", "remote.origin.pushurl", f.origin);
  await git(f.storefront, "config", "--add", "remote.origin.pushurl", other);
  expect(await f.operations.preview(request)).toMatchObject({
    status: "blocked",
    diagnostic: expect.stringContaining("multiple"),
  });
  expect(await git(other, "show-ref", "--heads").catch(() => "")).toBe("");
});
it("uses the publication GitHub destination in storefront summaries and keeps workshop identity unchanged", async () => {
  const f = await fixture();
  await git(f.storefront, "remote", "set-url", "origin", "https://github.com/fixture/fetch.git");
  await git(f.storefront, "config", "remote.origin.pushurl", "https://github.com/fixture/public.git");
  expect(await inspectStorefrontFolder(f.storefront, undefined)).toMatchObject({ githubRepository: "fixture/public" });
});
it("publishes binary skill support bytes while retaining truthful reference presence", async () => {
  const f = await fixture();
  const bytes = Uint8Array.from([0, 123, 123, 0]);
  await write(f.workshop, "packages/demo/skills/demo/example.bin", bytes);
  const skill = await readFile(join(f.workshop, "packages/demo/skills/demo/SKILL.md"), "utf8");
  await write(f.workshop, "packages/demo/skills/demo/SKILL.md", skill + "\n[Example](example.bin)\n");
  await commit(f.workshop);
  const preview = await f.operations.preview(request);
  expect(preview.status).toBe("ready");
  const result = await f.operations.apply({ planId: ready(preview).planId });
  expect(result!.status).toBe("applied");
  expect(await readFile(join(f.storefront, "plugins/demo/skills/demo/example.bin"))).toEqual(Buffer.from(bytes));
  expect(await git(f.origin, "rev-parse", "refs/heads/main")).toBe(result!.receipt.git.commit);
  expect(Buffer.from(await git(f.origin, "show", "refs/heads/main:plugins/demo/skills/demo/example.bin"))).toEqual(
    Buffer.from(bytes),
  );
});
it("still blocks placeholders in actual text and missing binary references", async () => {
  const f = await fixture();
  await write(f.workshop, "packages/demo/skills/demo/example.txt", "{{unfinished}}\n");
  await commit(f.workshop);
  const placeholder = await f.operations.preview(request);
  expect(
    placeholder.status === "blocked" &&
      placeholder.plan?.publication?.findings.some((finding) => finding.message.includes("placeholder-text")),
  ).toBe(true);
  await write(f.workshop, "packages/demo/skills/demo/example.txt", "Finished text\n");
  const skill = await readFile(join(f.workshop, "packages/demo/skills/demo/SKILL.md"), "utf8");
  await write(f.workshop, "packages/demo/skills/demo/SKILL.md", skill + "\n[Missing](missing.bin)\n");
  await commit(f.workshop);
  expect((await f.operations.preview(request)).status).toBe("blocked");
});
it.each(["publish", "retry", "create"])(
  "keeps %s definitively unpushed and recoverable for a missing local origin",
  async (kind) => {
    const f = await fixture();
    const missing = join(f.root, "missing.git");
    await git(f.storefront, "remote", "set-url", "origin", missing);
    const first = await f.operations.apply({ planId: ready(await f.operations.preview(request)).planId });
    const previewRequest =
      kind === "create"
        ? {
            kind: "create-storefront" as const,
            name: "public-plugins",
            license: "MIT" as const,
            login: "fixture",
            repositoryUrl: missing,
          }
        : { kind: "retry-push" as const, operationId: first!.receipt.operationId };
    const result =
      kind === "publish"
        ? first
        : await f.operations.apply({ planId: ready(await f.operations.preview(previewRequest)).planId });
    expect(result).toMatchObject({ status: "failed", receipt: { publication: { state: "committed-not-pushed" } } });
    for (const recovery of ["retry-push", "restore-import"] as const)
      expect(await f.operations.preview({ kind: recovery, operationId: result!.receipt.operationId })).toMatchObject({
        status: "ready",
      });
  },
);
it("scans meaningful sensitive literals in binary support files without checking their placeholder bytes", async () => {
  const f = await fixture();
  await write(f.workshop, "packages/demo/skills/demo/example.bin", Buffer.from("\0{{\0ghp_1234567890abcdefghijkl\0"));
  await commit(f.workshop);
  const result = await f.operations.preview(request);
  expect(result.status).toBe("blocked");
  expect(result.plan?.publication?.findings.some((finding) => finding.code === "secret")).toBe(true);
  expect(result.plan?.publication?.findings.some((finding) => finding.message.includes("placeholder-text"))).toBe(
    false,
  );
  expect(JSON.stringify(result)).not.toContain("ghp_1234567890abcdefghijkl");
});
it("keeps credentials private while the adapter receives the complete reviewed push destination", async () => {
  const f = await fixture();
  const remoteUrl = "https://fixture:private-proof@example.test/storefront.git";
  let pushedTarget: unknown;
  const operations = createPublicationOperations({
    ...f.options,
    git: {
      ...f.options.git,
      remoteUrl: async () => remoteUrl,
      push: async (_root, _remote, _branch, target) => {
        pushedTarget = target;
        return { status: "pushed" };
      },
    },
  });
  const preview = await operations.preview(request);
  expect(JSON.stringify(preview)).not.toContain("private-proof");
  const result = await operations.apply({ planId: ready(preview).planId });
  expect(pushedTarget).toMatchObject({ remoteUrl });
  expect(result!.receipt.publication?.remoteUrl).toBe("https://example.test/storefront.git");
  expect(JSON.stringify(result)).not.toContain("private-proof");
  expect(await readFile(join(f.data, "omni/operations.json"), "utf8")).not.toContain("private-proof");
});
