import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { parseAgentMutationResponse } from "../../src/shared/agents-ipc";
import { createPublicationsStore, publicationsFilePath } from "../../src/main/storefronts/publications-store";
import { publicationFixture, git, write, commit } from "../helpers/publication-fixture";
import { createPublicationOperations } from "../../src/main/storefronts/operations";
import { samePlan } from "../../src/shared/agent-plan-freshness";
import { parsePreviewMarketplaceResponse, type PreviewMarketplaceResponse } from "../../src/shared/operations-ipc";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";

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
function ready(value: PreviewMarketplaceResponse) {
  if (value.status !== "ready") throw new Error(value.diagnostic);
  return value.plan;
}
const request = { kind: "publish-plugin" as const, pluginId: "demo", storefrontId: "storefront" };
it("requires new approval when origin changes despite identical displayed files", async () => {
  const f = await fixture();
  const before = ready(await f.operations.preview(request));
  const other = join(f.root, "other.git");
  await git(f.root, "init", "--bare", other);
  await git(f.storefront, "remote", "set-url", "origin", other);
  const after = ready(await f.operations.preview(request));
  expect(before.actions).toEqual(after.actions);
  expect(samePlan(before, after)).toBe(false);
});
it.each(["branch", "head", "workshop"])("requires new approval when %s state changes", async (state) => {
  const f = await fixture();
  const before = ready(await f.operations.preview(request));
  if (state === "branch") await git(f.storefront, "checkout", "-qb", "other");
  if (state === "head") {
    await write(f.storefront, "owner.txt", "Owner commit\n");
    await commit(f.storefront);
  }
  if (state === "workshop") {
    await write(f.workshop, "outside.txt", "Workshop commit\n");
    await commit(f.workshop);
  }
  expect(samePlan(before, ready(await f.operations.preview(request)))).toBe(false);
});
it.each([false, true])("keeps unchanged approval stable across midnight with new storefront = %s", async (create) => {
  const f = await fixture();
  let time = Date.parse("2026-10-12T23:59:00.000Z");
  const operations = createPublicationOperations({ ...f.options, now: () => time });
  const input = create
    ? {
        kind: "publish-plugin" as const,
        pluginId: "demo",
        newStorefront: { name: "public-plugins", license: "MIT" as const, login: "fixture", repositoryUrl: f.origin },
      }
    : request;
  const before = ready(await operations.preview(input));
  time += 120000;
  const after = ready(await operations.preview(input));
  expect(before.planId).not.toBe(after.planId);
  expect(samePlan(before, after)).toBe(true);
  const parsed = ready(parsePreviewMarketplaceResponse({ status: "ready", plan: before }));
  expect(parsed).toEqual(before);
  const path = join(f.data, "omni/agent-requests.json");
  const requests = createAgentRequestsStore(path);
  const saved = await requests.create({
    request: input,
    plan: parsed,
    approval: "omni",
    approvalReason: { code: "public-publication" },
  });
  const stored = await createAgentRequestsStore(path).get(saved.requestId);
  expect(stored?.plan).toEqual(before);
  expect(samePlan(stored!.plan, after)).toBe(true);
  expect(JSON.parse(await readFile(path, "utf8")).requests[0].plan.publication.approvalFingerprint).toMatch(
    /^[0-9a-f]{64}$/u,
  );
  expect(() =>
    parsePreviewMarketplaceResponse({
      status: "ready",
      plan: { ...before, publication: { ...before.publication, approvalFingerprint: "invalid" } },
    }),
  ).toThrow();
  expect(() =>
    parsePreviewMarketplaceResponse({
      status: "ready",
      plan: { ...before, publication: { ...before.publication, unexpected: true } },
    }),
  ).toThrow();
  expect(() =>
    parseAgentMutationResponse({
      ...saved,
      plan: { ...before, publication: { ...before.publication, approvalFingerprint: "invalid" } },
    }),
  ).toThrow();
  const result = await operations.apply({ planId: before.planId });
  expect(result?.status).toBe("applied");
  const root = create ? join(f.root, "public-plugins") : f.storefront;
  const origin = await readFile(join(root, "plugins/demo/ORIGIN.md"));
  expect(origin.toString("utf8")).toContain("- Published: 2026-10-13");
  expect(result?.receipt.actions.find((action) => action.relativePath === "plugins/demo/ORIGIN.md")?.afterHash).toBe(
    createHash("sha256").update(origin).digest("hex"),
  );
});

it("binds approval to publication metadata without exposing origin credentials", async () => {
  const f = await fixture();
  const initial = ready(await f.operations.preview(request));
  await f.operations.apply({ planId: initial.planId });
  const before = ready(await f.operations.preview(request));
  const publications = createPublicationsStore(publicationsFilePath(f.data));
  const loaded = await publications.read();
  if (loaded.status !== "ready") throw new Error("Missing fixture publications");
  await publications.save([{ ...loaded.publications[0]!, publishedTime: "2026-10-12T11:00:00.000Z" }]);
  const after = ready(await f.operations.preview(request));
  expect(before.actions).toEqual(after.actions);
  expect(samePlan(before, after)).toBe(false);
  const credential = "ghp_abcdefghijklmnopqrstuvwxyz";
  await git(f.storefront, "remote", "set-url", "origin", `https://${credential}@github.com/fixture/storefront.git`);
  expect(JSON.stringify(ready(await f.operations.preview(request)))).not.toContain(credential);
});
