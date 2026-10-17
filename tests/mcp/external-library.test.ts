import { expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { createOmniServer } from "../../packages/omni-mcp/src/server";

it("exposes read-only library state and routes external install previews through the gateway", async () => {
  const request = vi.fn(async (method: string) => ({
    ok: true as const,
    result:
      method === "list_external_library"
        ? {
            sources: [
              { source: { id: "fixture/tools" }, skills: [{ path: "skills/prototype", useIds: [] }], uses: [] },
            ],
          }
        : { status: "blocked", reason: "Fixture preview" },
  }));
  const server = createOmniServer({ request, close: async () => undefined });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "omni_list_external_library")).toBeDefined();
    expect(tools.find((tool) => tool.name === "omni_preview_install_external")?.description).toContain(
      "Approval happens in Omni",
    );
    await client.callTool({ name: "omni_list_external_library", arguments: {} });
    expect(request).toHaveBeenLastCalledWith("list_external_library", {});
    const input = {
      sourceId: "fixture/tools",
      skillPath: "skills/prototype",
      skillName: "prototype",
      targets: [{ projectId: "project-a", harnessIds: ["codex"] }],
      conflict: "refuse",
    };
    await client.callTool({ name: "omni_preview_install_external", arguments: input });
    expect(request).toHaveBeenLastCalledWith("preview_install_external", input);
    const calls = request.mock.calls.length;
    const result = await client.callTool({
      name: "omni_preview_install_external",
      arguments: { ...input, skillName: "../escape" },
    });
    expect(result.isError).toBe(true);
    expect(request.mock.calls).toHaveLength(calls);
  } finally {
    await client.close();
    await server.close();
  }
});
