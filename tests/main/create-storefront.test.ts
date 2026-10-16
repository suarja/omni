import { readFile, rm, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publicationFixture, git, write } from "../helpers/publication-fixture";
import { buildCreatePlan } from "../../src/main/storefronts/create-plan";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const roots: string[] = [];
async function fixture(gh?: Parameters<typeof publicationFixture>[0]) {
  const f = await publicationFixture(gh);
  roots.push(f.root);
  return f;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each([
  {
    kind: "credentialed HTTPS",
    repositoryUrl: "https://ghp_1234567890abcdefghijkl@github.com/team/existing-storefront.git",
  },
  { kind: "SSH", repositoryUrl: "ssh://git@github.com/team/existing-storefront.git" },
])("uses the supplied $kind repository identity when the folder name differs", async ({ repositoryUrl }) => {
  const f = await fixture();
  const plan = await buildCreatePlan(f.options, {
    name: "local-title",
    license: "MIT",
    login: "fixture",
    repositoryUrl,
  });
  const readme = Buffer.from(plan.files["README.md"]!).toString("utf8");
  expect(readme).toContain("/plugin marketplace add team/existing-storefront");
  expect(readme).toContain("https://github.com/team/existing-storefront");
  expect(readme).toContain("/plugin install plugin-name@local-title");
  expect(readme).not.toContain("ghp_1234567890abcdefghijkl");
});
it.each(["MIT", "Apache-2.0"])(
  "creates a registered empty storefront with %s and an existing local origin",
  async (license) => {
    const f = await fixture();
    const preview = await f.operations.preview({
      kind: "create-storefront",
      name: "public-plugins",
      license,
      login: "fixture",
      repositoryUrl: f.origin,
    });
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    const folder = join(f.root, "public-plugins");
    await expect(readFile(join(folder, "README.md"))).rejects.toThrow();
    const result = await f.operations.apply({ planId: preview.plan.planId });
    expect(result).toMatchObject({
      status: "applied",
      receipt: { kind: "create-storefront", publication: { state: "pushed" } },
    });
    expect(await readFile(join(folder, "LICENSE"), "utf8")).toContain("2026 fixture");
    expect(await readFile(join(folder, "LICENSE"), "utf8")).toContain(
      license === "MIT" ? "Permission is hereby granted" : "TERMS AND CONDITIONS",
    );
    const readme = await readFile(join(folder, "README.md"), "utf8");
    expect(readme).toContain("<!-- omni:plugins -->\n<!-- /omni:plugins -->");
    expect(readme).toContain("## Install");
    for (const path of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"])
      expect(JSON.parse(await readFile(join(folder, path), "utf8"))).toMatchObject({
        name: "public-plugins",
        plugins: [],
      });
    expect(await git(folder, "remote", "get-url", "origin")).toBe(f.origin);
    expect(await git(f.origin, "rev-parse", "refs/heads/main")).toBe(await git(folder, "rev-parse", "HEAD"));
    const loaded = await f.registry.read();
    expect(
      loaded.status === "ready" &&
        loaded.state.sources.some((source) => source.role === "storefront" && source.locator.canonicalPath === folder),
    ).toBe(true);
  },
);
it("uses only injected authenticated gh creation with the chosen public identity", async () => {
  let origin = "";
  const repoCreate = vi.fn(async (repository: string, directory: string) => {
    expect(repository).toBe("fixture/public-plugins");
    await git(directory, "remote", "add", "origin", origin);
    await git(directory, "push", "origin", "main");
    return { status: "created" as const };
  });
  const gh = { available: async () => true, login: async () => "fixture", repoCreate };
  const f = await fixture(gh);
  origin = f.origin;
  const preview = await f.operations.preview({ kind: "create-storefront", name: "public-plugins", license: "MIT" });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  expect(await f.operations.apply({ planId: preview.plan.planId })).toMatchObject({ status: "applied" });
  expect(repoCreate).toHaveBeenCalledOnce();
});
it("publishes directly into a new storefront after previewing all publication changes", async () => {
  const f = await fixture();
  const preview = await f.operations.preview({
    kind: "publish-plugin",
    pluginId: "demo",
    newStorefront: { name: "public-plugins", license: "MIT", login: "fixture", repositoryUrl: f.origin },
  });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  expect(preview.plan.actions.some((action) => action.relativePath === "plugins/demo/ORIGIN.md")).toBe(true);
  expect(await f.operations.apply({ planId: preview.plan.planId })).toMatchObject({
    status: "applied",
    receipt: { kind: "publish-plugin", publication: { state: "pushed" } },
  });
  expect(await readFile(join(f.root, "public-plugins/plugins/demo/ORIGIN.md"), "utf8")).toContain(f.workshopCommit);
});
it("blocks missing fallback URL, existing directories and changed gh login without effects", async () => {
  const login = vi.fn(async () => "fixture");
  const repoCreate = vi.fn(async () => ({ status: "created" as const }));
  const f = await fixture({ available: async () => true, login, repoCreate });
  const preview = await f.operations.preview({ kind: "create-storefront", name: "public-plugins", license: "MIT" });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  login.mockResolvedValue("someone-else");
  expect(await f.operations.apply({ planId: preview.plan.planId })).toMatchObject({ status: "failed" });
  expect(repoCreate).not.toHaveBeenCalled();
  await mkdir(join(f.root, "existing"));
  expect(await f.operations.preview({ kind: "create-storefront", name: "existing", license: "MIT" })).toMatchObject({
    status: "blocked",
  });
  const noGh = await fixture();
  expect(
    await noGh.operations.preview({ kind: "create-storefront", name: "public-plugins", license: "MIT" }),
  ).toMatchObject({ status: "blocked" });
});
it("preserves a directory created after preview", async () => {
  const f = await fixture();
  const preview = await f.operations.preview({
    kind: "create-storefront",
    name: "public-plugins",
    license: "MIT",
    login: "fixture",
    repositoryUrl: f.origin,
  });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  await write(join(f.root, "public-plugins"), "owner.txt", "Keep me");
  expect(await f.operations.apply({ planId: preview.plan.planId })).toMatchObject({ status: "failed" });
  expect(await readFile(join(f.root, "public-plugins/owner.txt"), "utf8")).toBe("Keep me");
});
it("blocks a symlink at the proposed storefront path", async () => {
  const f = await fixture();
  await symlink(f.storefront, join(f.root, "public-plugins"));
  expect(
    await f.operations.preview({
      kind: "create-storefront",
      name: "public-plugins",
      license: "MIT",
      login: "fixture",
      repositoryUrl: f.origin,
    }),
  ).toMatchObject({ status: "blocked" });
});

it("preserves the pushed creation receipt if the workshop changes before the plugin publication", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  const gh = {
    available: async () => true,
    login: async () => "fixture",
    repoCreate: async (_repository: string, directory: string) => {
      await git(directory, "remote", "add", "origin", f.origin);
      await git(directory, "push", "origin", "main");
      await write(f.workshop, "packages/demo/same.txt", "Changed during creation\n");
      return { status: "created" as const };
    },
  };
  f = await fixture(gh);
  const preview = await f.operations.preview({
    kind: "publish-plugin",
    pluginId: "demo",
    newStorefront: { name: "public-plugins", license: "MIT" },
  });
  if (preview.status !== "ready") throw new Error(preview.diagnostic);
  const result = await f.operations.apply({ planId: preview.plan.planId });
  expect(result).toMatchObject({ status: "failed", receipt: { kind: "publish-plugin", children: expect.any(Array) } });
  const saved = await f.store.read();
  expect(
    saved.status === "ready" &&
      saved.receipts.some((receipt) => receipt.kind === "create-storefront" && receipt.publication?.state === "pushed"),
  ).toBe(true);
  if (saved.status !== "ready") throw new Error("Missing fixture receipts");
  const created = saved.receipts.find(
    (receipt) => receipt.kind === "create-storefront" && receipt.publication?.state === "pushed",
  )!;
  expect(result?.receipt.children).toContain(created.operationId);
  expect(result?.receipt.registered).toEqual(created.registered);
  const registered = await f.registry.read();
  if (registered.status !== "ready") throw new Error("Missing fixture registry");
  expect(registered.state.sources.find((source) => source.id === created.registered?.sourceId)).toMatchObject({
    role: "storefront",
    locator: { canonicalPath: join(f.root, "public-plugins") },
  });
});
