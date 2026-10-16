import { expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { createOmniServer } from "../../packages/omni-mcp/src/server";

it("exposes project registration with caller cwd, consent, Undo and already-known ids", async () => {
  const request = vi.fn(async () => ({
    ok: true as const,
    result: { status: "ready", projectId: "registered-project" } as Record<string, unknown>,
  }));
  const server = createOmniServer({ request, close: async () => undefined });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "registration-test", version: "1" });
  await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find((tool) => tool.name === "omni_preview_register_project");
    expect(tool?.description).toContain("working directory");
    expect(tool?.description).toContain("another project");
    expect(tool?.description).toContain("conversation");
    expect(tool?.description).toContain("archives");
    request.mockResolvedValueOnce({
      ok: true,
      result: {
        requestId: "preview",
        approval: "conversation",
        plan: {
          kind: "register-project",
          actions: [],
          notes: [
            "Register project demo (/demo, git root). Omni will read its skills; nothing is written in the folder. Undo archives it.",
          ],
        },
      },
    });
    const preview = await client.callTool({ name: "omni_preview_register_project", arguments: {} });
    expect(JSON.parse((preview.content as Array<{ text: string }>)[0].text).summary).toContain("Register project demo");
    const response = await client.callTool({
      name: "omni_preview_register_project",
      arguments: { path: "../sibling-project", reason: "Assign a skill." },
    });
    expect(request).toHaveBeenCalledWith("preview_register_project", {
      path: "../sibling-project",
      reason: "Assign a skill.",
    });
    expect(JSON.parse((response.content as Array<{ text: string }>)[0].text)).toMatchObject({
      status: "ready",
      projectId: "registered-project",
    });
  } finally {
    await client.close();
    await server.close();
  }
});
