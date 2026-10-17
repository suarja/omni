import { expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { createOmniServer } from "../../packages/omni-mcp/src/server";

it("exposes storefront linking with a required local path and personal-source approval", async () => {
  const request = vi.fn(async () => ({ ok: true as const, result: { status: "ready", storefrontId: "linked" } }));
  const server = createOmniServer({ request, close: async () => undefined });
  const [transport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(transport);
  const client = new Client({ name: "link-test", version: "1" });
  await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find((item) => item.name === "omni_preview_link_storefront");
    expect(tool?.description).toContain("personal");
    expect(tool?.description).toContain("working directory");
    for (const args of [{}, { path: "" }, { path: "demo", extra: true }, { path: "demo", reason: 1 }]) {
      expect((await client.callTool({ name: "omni_preview_link_storefront", arguments: args })).isError).toBe(true);
    }
    expect(request).not.toHaveBeenCalled();
    const result = await client.callTool({
      name: "omni_preview_link_storefront",
      arguments: { path: "../storefront", reason: "Link a colleague's destination." },
    });
    expect(request).toHaveBeenCalledWith("preview_link_storefront", {
      path: "../storefront",
      reason: "Link a colleague's destination.",
    });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({ storefrontId: "linked" });
  } finally {
    await client.close();
    await server.close();
  }
});
