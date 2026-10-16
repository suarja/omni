import { expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { createOmniServer } from "../../packages/omni-mcp/src/server";

it("requires and forwards a new plugin's English description through capture", async () => {
  const request = vi.fn(async () => ({
    ok: true as const,
    result: {
      requestId: "capture-request",
      approval: "conversation",
      plan: {
        kind: "import-artifact",
        displayTarget: "packages/build-to-show",
        actions: [],
        git: { mode: "commit" },
        notes: ["New plugin build-to-show: Build posts from shipped work."],
      },
    },
  }));
  const server = createOmniServer({ request, close: async () => undefined });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "capture-test", version: "1" });
  await client.connect(clientTransport);
  try {
    const target = { newPackageName: "build-to-show", description: "Build posts from shipped work." };
    const result = await client.callTool({
      name: "omni_preview_capture",
      arguments: { projectId: "project-1", relativePath: ".agents/skills/demo", target },
    });
    expect(request).toHaveBeenCalledWith("preview_capture", {
      projectId: "project-1",
      relativePath: ".agents/skills/demo",
      target,
    });
    expect(JSON.stringify(result)).toContain("Build posts from shipped work.");
    request.mockClear();
    const missing = await client.callTool({
      name: "omni_preview_capture",
      arguments: {
        projectId: "project-1",
        relativePath: ".agents/skills/demo",
        target: { newPackageName: "build-to-show" },
      },
    });
    expect(missing.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
  }
});
