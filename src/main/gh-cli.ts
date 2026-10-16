import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export type GhCreateResult = Readonly<{ status: "created" }> | Readonly<{ status: "failed"; diagnostic: string }>;
export interface GhCli {
  available(): Promise<boolean>;
  login(): Promise<string | undefined>;
  repoCreate(repository: string, directory: string): Promise<GhCreateResult>;
}
async function run(args: readonly string[]): Promise<string> {
  return (
    await exec("gh", [...args], {
      shell: false,
      timeout: 30000,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
        GIT_CONFIG_KEY_1: "core.fsmonitor",
        GIT_CONFIG_VALUE_1: "false",
      },
    })
  ).stdout.trim();
}
export const systemGhCli: GhCli = {
  available: async () => {
    try {
      await run(["--version"]);
      return true;
    } catch {
      return false;
    }
  },
  login: async () => {
    try {
      const login = await run(["api", "user", "--jq", ".login"]);
      return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(login) ? login : undefined;
    } catch {
      return undefined;
    }
  },
  repoCreate: async (repository, directory) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(repository))
      return { status: "failed", diagnostic: "GitHub repository identity is invalid." };
    try {
      await run(["repo", "create", repository, "--public", "--source", directory, "--remote", "origin", "--push"]);
      return { status: "created" };
    } catch {
      return {
        status: "failed",
        diagnostic:
          "GitHub repository creation or its initial push failed. Inspect the repository and local origin before retrying.",
      };
    }
  },
};
