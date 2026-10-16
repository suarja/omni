import { expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "../../packages/omni-mcp/testing/sdk";
import { createOmniServer } from "../../packages/omni-mcp/src/server";
import { previewSkill } from "../../src/main/agent-gateway/router-skill";

it("forwards a described new plugin through create-skill and includes it in the summary", async () => {
  const request = vi.fn(async () => ({
    ok: true as const,
    result: {
      requestId: "create-request",
      approval: "conversation",
      plan: {
        kind: "write-skill",
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
  const client = new Client({ name: "create-test", version: "1" });
  await client.connect(clientTransport);
  const newPackage = { name: "build-to-show", description: "Build posts from shipped work." };
  const input = {
    sourceId: "personal",
    newPackage,
    folderName: "demo",
    files: [
      { path: "SKILL.md", content: "---\nname: demo\ndescription: Use when sharing shipped work.\n---\n\n# Demo\n" },
    ],
  };
  try {
    const result = await client.callTool({ name: "omni_preview_create_skill", arguments: input });
    expect(request).toHaveBeenCalledWith("preview_create_skill", {
      sourceId: "personal",
      newPackage,
      name: "demo",
      description: "Use when sharing shipped work.",
      body: "# Demo\n",
      files: [],
    });
    expect(JSON.stringify(result)).toContain(newPackage.description);
    for (const destination of [
      { newPackage: { name: "missing-description" } },
      { packageId: "packages/existing", newPackage },
      { newPackage: undefined },
    ]) {
      request.mockClear();
      expect(
        (await client.callTool({ name: "omni_preview_create_skill", arguments: { ...input, ...destination } })).isError,
      ).toBe(true);
      expect(request).not.toHaveBeenCalled();
    }
  } finally {
    await client.close();
    await server.close();
  }
});
it("accepts the same new plugin at the authenticated gateway write boundary", async () => {
  const preview = vi.fn(async () => ({}));
  await previewSkill(
    "preview_create_skill",
    {
      sourceId: "personal",
      newPackage: { name: "demo-tools", description: "Tools for demonstrations." },
      name: "demo",
      description: "Use when demonstrating work.",
      body: "# Demo\n",
    },
    { harness: "codex", sessionName: "demo" } as any,
    preview,
  );
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "write-skill",
      mode: "create",
      newPackage: { name: "demo-tools", description: "Tools for demonstrations." },
    }),
    expect.anything(),
    undefined,
  );
});
