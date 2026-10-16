import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultUserDataPath =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "omni-desktop")
    : process.platform === "win32"
      ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "omni-desktop")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "omni-desktop");
const candidates = [
  process.env.OMNI_MCP_CLI,
  resolve(pluginRoot, "runtime/omni-mcp.mjs"),
  join(process.env.OMNI_USER_DATA ?? defaultUserDataPath, "omni", "mcp", "omni-mcp.mjs"),
  resolve(pluginRoot, "../../packages/omni-mcp/dist/cli.js"),
].filter(Boolean);

let cliPath;
for (const candidate of candidates) {
  try {
    await access(candidate, constants.R_OK);
    cliPath = candidate;
    break;
  } catch {
    // Try the next explicitly supported installation location.
  }
}

if (!cliPath) {
  console.error("Omni MCP is unavailable. Open Omni Desktop or set OMNI_MCP_CLI to the built omni-mcp CLI path.");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
    env: {
      ...process.env,
      OMNI_MCP_SOURCE: process.env.OMNI_MCP_SOURCE ?? "codex-plugin",
      OMNI_MCP_HARNESS: process.env.OMNI_MCP_HARNESS ?? "codex",
      OMNI_MCP_RUNTIME_PATH: cliPath,
    },
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
