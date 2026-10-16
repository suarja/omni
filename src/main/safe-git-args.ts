const SAFE_GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;

export function safeGitArgs(args: readonly string[]): string[] {
  return [...SAFE_GIT_CONFIG, ...args];
}
