import { safeGitArgs } from "./safe-git-args";

export function gitTransportEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_LFS_SKIP_SMUDGE: "1",
    LC_ALL: "C",
    LANGUAGE: "C",
  };
}
export function safeGitTransportArgs(args: readonly string[]): string[] {
  return safeGitArgs([
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.process=",
    "-c",
    "filter.lfs.required=false",
    ...args,
  ]);
}
