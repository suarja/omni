import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { newStorefrontSchema, conflictChoicesSchema } from "../../../src/shared/publication-operations-ipc.js";
import { OMNI_APPROVAL_INSTRUCTIONS } from "./approval-text.js";
import type { GatewayClientLike, GatewayResult } from "./gateway-client.js";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
export function registerPublicationPreview(
  server: McpServer,
  gateway: GatewayClientLike,
  present: (result: GatewayResult) => CallToolResult,
): void {
  server.registerTool(
    "omni_preview_publish",
    {
      description:
        "Preview publishing a complete workshop plugin to an existing or new public storefront. Checks block unsafe content. Fix content in the workshop. Publishing always waits for the owner's approval in Omni Desktop, whatever the agent settings. Call omni_apply with the returned requestId to wait for that approval and receipt. " +
        OMNI_APPROVAL_INSTRUCTIONS,
      inputSchema: z
        .object({
          pluginId: id,
          storefrontId: id.optional(),
          newStorefront: newStorefrontSchema.optional(),
          conflictChoices: conflictChoicesSchema.optional(),
        })
        .strict(),
    },
    async (input) => present(await gateway.request("preview_publish", input)),
  );
}
