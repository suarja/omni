import { expect, it, vi } from "vitest";
import { parsePublishPluginRequest, parseCreateStorefrontRequest } from "../../src/shared/publication-operations-ipc";
import { parsePreviewOperationRequest, parseApplyOperationRequest } from "../../src/shared/operations-ipc";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

it("accepts one storefront destination and safe per-file choices", () => {
  const request = {
    kind: "publish-plugin",
    pluginId: "demo",
    storefrontId: "shop",
    conflictChoices: { "guide.md": "keep-storefront" },
  };
  expect(parsePublishPluginRequest(request)).toEqual(request);
  expect(parsePreviewOperationRequest(request)).toEqual(request);
  expect(
    parseApplyOperationRequest({ planId: "plan", conflictChoices: { "guide.md": "take-workshop" } }),
  ).toMatchObject({ conflictChoices: { "guide.md": "take-workshop" } });
});
it.each([
  { pluginId: "../escape", storefrontId: "shop" },
  { pluginId: "demo" },
  { pluginId: "demo", storefrontId: "shop", newStorefront: { name: "new", license: "MIT" } },
  { pluginId: "demo", storefrontId: "shop", conflictChoices: { "../escape": "take-workshop" } },
  { pluginId: "demo", storefrontId: "shop", conflictChoices: { a: "anything" } },
])("rejects unsafe or ambiguous publish input %j", (input) =>
  expect(() => parsePublishPluginRequest({ kind: "publish-plugin", ...input })).toThrow(),
);
it("requires a login when creating without authenticated gh", () => {
  expect(
    parseCreateStorefrontRequest({
      kind: "create-storefront",
      name: "shop",
      license: "MIT",
      login: "fixture",
      repositoryUrl: "/tmp/local.git",
    }),
  ).toMatchObject({ name: "shop" });
  expect(() => parseCreateStorefrontRequest({ kind: "create-storefront", name: "../shop", license: "MIT" })).toThrow();
  expect(() => parseCreateStorefrontRequest({ kind: "create-storefront", name: "shop", license: "Unknown" })).toThrow();
});
