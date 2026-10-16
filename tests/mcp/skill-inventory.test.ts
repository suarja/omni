import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { createOmniServer } from "../../packages/omni-mcp/src/server";

describe("inventory MCP pagination contract", () => {
  it("advertises a strict cursor schema and forwards cursor-only continuations", async () => {
    const request = vi.fn(async () => ({
      ok: true as const,
      result: { status: "ready", scopes: [], units: [], limits: [] },
    }));
    const server = createOmniServer({ request, close: async () => undefined });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inventory-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const inventory = tools.tools.find((tool) => tool.name === "omni_skill_inventory")!;
      expect(inventory.inputSchema).toMatchObject({
        additionalProperties: false,
        properties: { cursor: { type: "string", minLength: 1, maxLength: 128 } },
      });
      await client.callTool({ name: "omni_skill_inventory", arguments: { cursor: "snapshot:64" } });
      expect(request).toHaveBeenLastCalledWith("skill_inventory", { cursor: "snapshot:64" });
      const count = request.mock.calls.length;
      for (const args of [{ cursor: 2 }, { cursor: "" }, { cursor: "x".repeat(129) }, { unknown: true }]) {
        const result = await client.callTool({ name: "omni_skill_inventory", arguments: args });
        expect(result.isError).toBe(true);
      }
      expect(request).toHaveBeenCalledTimes(count);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
