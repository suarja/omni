import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { publicationFixture, commit, write, git } from "../helpers/publication-fixture";
import { parsePublishPluginRequest } from "../../src/shared/publication-operations-ipc";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each([
  ["constructor", "keep-storefront"],
  ["constructor", "take-workshop"],
  ["__proto__", "keep-storefront"],
  ["__proto__", "take-workshop"],
] as const)("publishes the ordinary own filename %s and applies %s to its conflict", async (name, choice) => {
  const f = await publicationFixture();
  roots.push(f.root);
  await write(f.workshop, `packages/demo/${name}`, "initial\n");
  await commit(f.workshop);
  const first = await f.operations.preview({ kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" });
  expect(first.status).toBe("ready");
  if (first.status !== "ready") throw new Error(first.diagnostic);
  expect(await f.operations.apply({ planId: first.plan.planId })).toMatchObject({ status: "applied" });
  expect(await readFile(join(f.storefront, `plugins/demo/${name}`), "utf8")).toBe("initial\n");
  await write(f.workshop, `packages/demo/${name}`, "workshop\n");
  await commit(f.workshop);
  await write(f.storefront, `plugins/demo/${name}`, "storefront\n");
  await commit(f.storefront);
  const unresolved = await f.operations.preview({
    kind: "publish-plugin",
    pluginId: "demo",
    storefrontId: "storefront",
  });
  expect(unresolved.status === "ready" && unresolved.plan.publication?.conflicts).toContain(name);
  {
    const parsed = parsePublishPluginRequest({
      kind: "publish-plugin",
      pluginId: "demo",
      storefrontId: "storefront",
      conflictChoices: Object.fromEntries([[name, choice]]),
    });
    expect(Object.hasOwn(parsed.conflictChoices!, name)).toBe(true);
    const preview = await f.operations.preview(parsed);
    expect(preview.status).toBe("ready");
    if (preview.status !== "ready") throw new Error(preview.diagnostic);
    expect(preview.plan.publication?.files.find((file) => file.path === name)).toMatchObject({
      classification: "conflict",
      choice,
    });
    expect(await f.operations.apply({ planId: preview.plan.planId })).toMatchObject({ status: "applied" });
    const expected = choice === "take-workshop" ? "workshop\n" : "storefront\n";
    expect(await readFile(join(f.storefront, `plugins/demo/${name}`), "utf8")).toBe(expected);
    expect(await git(f.origin, "show", `refs/heads/main:plugins/demo/${name}`)).toBe(expected.trim());
  }
});
it("ignores inherited conflict choices and rejects unsafe own choice paths", () => {
  const request = { kind: "publish-plugin", pluginId: "demo", storefrontId: "storefront" };
  const parsed = parsePublishPluginRequest({
    ...request,
    conflictChoices: Object.create({ constructor: "take-workshop" }),
  });
  expect(Object.keys(parsed.conflictChoices!)).toEqual([]);
  expect(() =>
    parsePublishPluginRequest({ ...request, conflictChoices: { "../constructor": "take-workshop" } }),
  ).toThrow();
});
