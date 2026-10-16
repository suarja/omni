import { describe, expect, it } from "vitest";

import { mcpEntryState } from "../../src/main/mcp-entry";

describe("MCP entry state", () => {
  it("requires the complete Claude entry, including Omni user data", () => {
    const content = JSON.stringify({
      mcpServers: { omni: { type: "stdio", command: "node", args: ["/opt/omni/cli.js"] } },
    });

    expect(mcpEntryState("claude-code", content, "/opt/omni/cli.js", "/tmp/omni-data")).toEqual({
      registered: true,
      current: false,
    });
  });

  it("requires the complete Codex block and rejects a different user-data path", () => {
    const content =
      '[mcp_servers.omni]\ncommand = "node"\nargs = [ "/opt/omni/cli.js" ]\n\n[mcp_servers.omni.env]\nOMNI_USER_DATA = "/tmp/other-data"\n';

    expect(mcpEntryState("codex", content, "/opt/omni/cli.js", "/tmp/omni-data")).toEqual({
      registered: true,
      current: false,
    });
  });

  it("accepts the exact Codex block Omni writes", () => {
    const content =
      '[mcp_servers.omni]\ncommand = "node"\nargs = [ "/opt/omni/cli.js" ]\n\n[mcp_servers.omni.env]\nOMNI_USER_DATA = "/tmp/omni-data"\n';

    expect(mcpEntryState("codex", content, "/opt/omni/cli.js", "/tmp/omni-data")).toEqual({
      registered: true,
      current: true,
    });
  });
});
