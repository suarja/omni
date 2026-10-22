import type { GitMode } from "../../shared/operations-ipc";

export function workshopPushWarnings(mode: GitMode, warnings: readonly string[]): readonly string[] {
  return mode === "commit" || mode === "init-and-commit"
    ? [
        ...warnings,
        "After the local workshop commit, Omni pushes to its configured upstream, including earlier unpushed commits. Push failure preserves the local commit and requires Retry; history is never rewritten.",
      ]
    : warnings;
}
