import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runGitCommand as command, redactGitDiagnostic as diagnostic } from "./git-command";
export type GitPushTarget = Readonly<{ remoteUrl: string; commit: string }>;
export type GitPushResult =
  Readonly<{ status: "pushed"; diagnostic?: string }> | Readonly<{ status: "failed" | "unknown"; diagnostic: string }>;
export function publicRepositoryUrl(value: string): string {
  if (!/^(?:https?|ssh):\/\//u.test(value)) return value;
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString();
}
async function destination(root: string, remote: string): Promise<string | undefined> {
  const text = await command(root, ["remote", "get-url", "--push", "--all", remote]).catch(() => undefined);
  if (!text) return undefined;
  const urls = text.split(/\r?\n/u);
  if (urls.length !== 1)
    throw new Error("Publication cannot use multiple push URLs. Select one destination and preview again.");
  const url = urls[0]!;
  if (url.startsWith("-") || /[\s\u0000-\u001f\u007f]/u.test(url))
    throw new Error("The effective publication destination is unsafe. Repair origin and preview again.");
  return url;
}
export async function remoteUrl(root: string): Promise<string | undefined> {
  return destination(root, "origin");
}
export async function resolveRepositoryPushUrl(root: string, url: string): Promise<string> {
  // New folders have no Git config yet; this reads the inherited URL rewrites without any transport.
  const text = await command(root, [
    "config",
    "--null",
    "--get-regexp",
    "^url\\..*\\.(insteadOf|pushInsteadOf)$",
  ]).catch(() => "");
  const rules = text.split("\0").flatMap((entry) => {
    const split = entry.indexOf("\n");
    const key = entry.slice(0, split).match(/^url\.(.*)\.(insteadof|pushinsteadof)$/iu);
    return key && split >= 0 ? [{ base: key[1]!, kind: key[2]!.toLowerCase(), prefix: entry.slice(split + 1) }] : [];
  });
  for (const kind of ["pushinsteadof", "insteadof"]) {
    const rule = rules
      .filter((rule) => rule.kind === kind && url.startsWith(rule.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (rule) return rule.base + url.slice(rule.prefix.length);
  }
  return url;
}
async function missingLocalDestination(url: string): Promise<boolean> {
  const path = url.startsWith("/") ? url : url.startsWith("file://") ? fileURLToPath(url) : undefined;
  if (!path) return false;
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}
async function proveOutcome(
  root: string,
  target: GitPushTarget,
  branch: string,
  message: string,
): Promise<GitPushResult> {
  try {
    const ref = `refs/heads/${branch}`;
    const text = await command(root, ["ls-remote", "--refs", target.remoteUrl, ref]);
    if (text.split(/\r?\n/u).some((line) => line === `${target.commit}\t${ref}`))
      return { status: "pushed", diagnostic: message };
  } catch {
    /* Inaccessible proof cannot authorize local restoration. */
  }
  return {
    status: "unknown",
    diagnostic: message + " The remote outcome could not be confirmed; local restore remains closed.",
  };
}
export async function push(
  root: string,
  remote: string,
  branch: string,
  reviewed?: GitPushTarget,
): Promise<GitPushResult> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote) ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) ||
    branch.includes("..") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock")
  )
    return { status: "failed", diagnostic: "Push requires a safe remote name and branch name." };
  let target: GitPushTarget;
  let receivePack: string | undefined;
  try {
    const url = await destination(root, remote);
    const commit = await command(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    if (!url || !/^[0-9a-f]{40,64}$/u.test(commit))
      throw new Error("The publication destination or branch is unavailable.");
    target = reviewed ?? { remoteUrl: url, commit };
    if (url !== target.remoteUrl || commit !== target.commit)
      throw new Error("The reviewed publication destination or commit changed. Preview again.");
    // An explicit URL prevents named-remote broadcasting. Reject any second rewrite of that URL.
    if ((await resolveRepositoryPushUrl(root, url)) !== url)
      throw new Error("The reviewed URL would be rewritten again. Repair its destination and preview again.");
    if (await missingLocalDestination(url))
      return {
        status: "failed",
        diagnostic: "The local origin repository does not exist. Repair origin and preview retry.",
      };
    receivePack = await command(root, ["config", "--get", `remote.${remote}.receivepack`]).catch(() => undefined);
  } catch (error) {
    return { status: "failed", diagnostic: diagnostic(error) };
  }
  try {
    await command(
      root,
      [
        "push",
        "--porcelain",
        ...(receivePack ? [`--receive-pack=${receivePack}`] : []),
        target.remoteUrl,
        `${target.commit}:refs/heads/${branch}`,
      ],
      30000,
    );
    return { status: "pushed" };
  } catch (error) {
    return proveOutcome(root, target, branch, diagnostic(error));
  }
}
