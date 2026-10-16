export const externalUseStates = ["up-to-date", "update", "modified", "removed", "unknown"] as const;
export type ExternalUseState = (typeof externalUseStates)[number];
export type ExternalUseDecision = Readonly<{ state: ExternalUseState; sourceChanged: boolean }>;

export function parseExternalRepository(value: string): string {
  let repo = value.trim();
  if (repo.startsWith("https://")) {
    const url = new URL(repo);
    if (url.hostname !== "github.com" || url.username || url.password || url.port || url.search || url.hash)
      throw new Error("An external source requires owner/repo or an HTTPS GitHub repository URL.");
    repo = url.pathname.slice(1).replace(/\/$/u, "");
  }
  repo = repo.replace(/\.git$/u, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(repo))
    throw new Error("An external source requires a safe GitHub owner/repo.");
  return repo.toLowerCase();
}
export function externalReadCopyFolder(repo: string): string {
  return parseExternalRepository(repo).replace("/", "__");
}

export function classifyExternalUse(
  evidence: Readonly<{
    lock: string;
    copy?: string;
    source?: string;
    removed?: boolean;
    failed?: boolean;
  }>,
): ExternalUseDecision {
  return classifyExternalVerification({
    ...evidence,
    verification: evidence.copy ? (evidence.copy === evidence.lock ? "matches-lock" : "modified") : "unverified",
  });
}
export function classifyExternalVerification(
  evidence: Readonly<{
    lock: string;
    verification: "matches-lock" | "modified" | "unverified";
    source?: string;
    removed?: boolean;
    failed?: boolean;
  }>,
): ExternalUseDecision {
  if (evidence.failed || evidence.verification === "unverified" || (!evidence.source && !evidence.removed))
    return { state: "unknown", sourceChanged: false };
  if (evidence.removed) return { state: "removed", sourceChanged: true };
  const sourceChanged = evidence.source !== evidence.lock;
  if (evidence.verification === "modified") return { state: "modified", sourceChanged };
  return { state: sourceChanged ? "update" : "up-to-date", sourceChanged };
}

export function projectExternalUseState(
  state: ExternalUseState,
): "current" | "update-available" | "modified-here" | "removed-upstream" | "unknown" {
  return {
    "up-to-date": "current",
    update: "update-available",
    modified: "modified-here",
    removed: "removed-upstream",
    unknown: "unknown",
  }[state] as ReturnType<typeof projectExternalUseState>;
}
