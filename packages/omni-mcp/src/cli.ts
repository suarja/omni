import { RUNTIME_VERSION } from "./version.js";
import { fileURLToPath, pathToFileURL } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createWakingGatewayClient } from "./desktop-wake-adapter.js";
import { defaultUserDataPath } from "./gateway-client.js";
import { createOmniServer } from "./server.js";

export const VERSION = RUNTIME_VERSION;

// The printed configuration points at this very build, so it works before any global install.
export function configText(target: "claude" | "codex", cliPath = fileURLToPath(import.meta.url)): string {
  if (target === "claude") {
    return (
      JSON.stringify(
        { mcpServers: { omni: { command: "node", args: [cliPath], env: { OMNI_USER_DATA: defaultUserDataPath() } } } },
        null,
        2,
      ) + "\n"
    );
  }
  return `[mcp_servers.omni]\ncommand = "node"\nargs = [${JSON.stringify(cliPath)}]\n\n[mcp_servers.omni.env]\nOMNI_USER_DATA = ${JSON.stringify(defaultUserDataPath())}\n`;
}

function usageError(message: string): never {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && argv[0] === "--version") {
    console.log(VERSION);
    return;
  }
  if (argv.length === 2 && argv[0] === "--print-config" && (argv[1] === "claude" || argv[1] === "codex")) {
    process.stdout.write(configText(argv[1]));
    return;
  }
  if (argv.length > 0) usageError("Usage: omni-mcp [--version | --print-config claude|codex]");
  const client = createWakingGatewayClient({ version: VERSION });
  const server = createOmniServer(client);
  await server.connect(new StdioServerTransport());
}

export function isCliEntrypoint(moduleUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && moduleUrl === pathToFileURL(entryPath).href;
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) void run().catch(() => undefined);
