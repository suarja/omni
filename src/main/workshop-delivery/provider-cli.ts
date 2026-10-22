import { promisify } from "node:util";
import { execFile } from "../../adapters/owned-child-processes";
import type { PluginUpdateCommand } from "../../shared/workshop-delivery-ipc";

const exec = promisify(execFile);
export function assertProviderCommandOutcome(stdout: string): void {
  let result: unknown;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    const line = stdout.trim().split(/\r?\n/u).at(-1);
    if (!line)
      throw new Error("The provider returned no update result. Inspect its installation records before retrying.");
    try {
      result = JSON.parse(line);
    } catch {
      throw new Error(
        "The provider update result was not readable JSON. Inspect its installation records before retrying.",
      );
    }
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("The provider update result is invalid.");
  const value = result as Record<string, unknown>;
  if (
    value.success === false ||
    value.status === "failed" ||
    value.status === "error" ||
    (Array.isArray(value.errors) && value.errors.length)
  )
    throw new Error("The provider CLI reported an update failure. Inspect the provider records and retry.");
}
export async function runProviderCommand(command: PluginUpdateCommand, home: string): Promise<void> {
  const result = await exec(command.executable, command.args, {
    cwd: command.cwd ?? home,
    shell: false,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: `${home}/.codex`,
      CLAUDE_CONFIG_DIR: `${home}/.claude`,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      CI: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    },
  });
  assertProviderCommandOutcome(result.stdout);
}
