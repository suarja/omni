import { githubRepository } from "./storefront-origin";

export function redactStorefrontOrigin(origin: string, homeDirectory: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(origin)) {
    const url = new URL(origin);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  const home = homeDirectory.replace(/\/$/u, "");
  if (origin === home) return "~";
  return origin.startsWith(`${home}/`) ? `~${origin.slice(home.length)}` : origin;
}

export function storefrontDestination(
  inspection: Readonly<{ githubRepository?: string; originUrl?: string }> | undefined,
): string {
  return inspection?.githubRepository ? `github.com/${inspection.githubRepository}` : (inspection?.originUrl ?? "");
}

export function githubDestinationRepository(origin: string): string | undefined {
  const scp = /^(?:[^@/]+@)?github\.com:(.+)$/iu.exec(origin);
  if (scp) return githubRepository(scp[1]!);
  try {
    const url = new URL(origin);
    return url.hostname === "github.com" && /^(?:https?|ssh|git):$/u.test(url.protocol)
      ? githubRepository(url.pathname.slice(1))
      : undefined;
  } catch {
    return undefined;
  }
}
