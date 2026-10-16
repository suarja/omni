import { expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { createOmniServer } from "../../packages/omni-mcp/src/server";

it("explains canonical package ids and short names for every package preview tool", async () => {
  const server = createOmniServer({ request: vi.fn(), close: async () => undefined });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "package-description-test", version: "1" });
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ["capture", "make_compatible", "assign", "create_skill", "update_skill", "sync_skill"]) {
      const description = tools.find((tool) => tool.name === `omni_preview_${name}`)?.description;
      expect(description).toContain("omni_list_marketplace or omni_find_skill");
      expect(description).toContain("packages/<name>");
      expect(description).toContain("short package name also works");
    }
  } finally {
    await client.close();
    await server.close();
  }
});
