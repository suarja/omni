import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { externalInstallSchema } from "../../../src/shared/external-skill-intents.js";
import { OMNI_APPROVAL_INSTRUCTIONS } from "./approval-text.js";

const inputSchema = externalInstallSchema.omit({ kind: true }).extend({ askInOmni: z.boolean().optional() });
export function registerExternalLibraryTools(
  server: McpServer,
  handlers: Readonly<{
    list(): Promise<CallToolResult>;
    preview(input: z.infer<typeof inputSchema>): Promise<CallToolResult>;
  }>,
): void {
  server.registerTool(
    "omni_list_external_library",
    {
      description:
        "Read external sources, per-project copy states, source licences and unused skills from Omni's last completed check. Read-only.",
      inputSchema: z.object({}).strict(),
    },
    handlers.list,
  );
  server.registerTool(
    "omni_preview_install_external",
    {
      description: `Preview installing a checked external skill into selected projects and agents with a backup, lock entry and Undo. Replacing a copy is a conflict requiring Omni approval. ${OMNI_APPROVAL_INSTRUCTIONS}`,
      inputSchema,
    },
    handlers.preview,
  );
}
