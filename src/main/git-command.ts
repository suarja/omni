import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { safeGitTransportArgs, gitTransportEnvironment } from "./git-transport";

const exec = promisify(execFile);
export async function runGitCommand(
  root: string,
  args: readonly string[],
  timeout = 15000,
  input?: string,
): Promise<string> {
  const pending = exec("git", safeGitTransportArgs(args), {
    cwd: root,
    shell: false,
    windowsHide: true,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: gitTransportEnvironment(),
  });
  pending.child.stdin?.end(input);
  const result = await pending;
  return result.stdout.trim();
}
export function redactGitDiagnostic(error: unknown): string {
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr)
      : error instanceof Error
        ? error.message
        : "Git command failed or timed out.";
  return (
    stderr
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .replace(/(?:https?|ssh):\/\/[^@\s]+@/gu, "https://[redacted]@")
      .replace(/(?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s]+/giu, "credential=[redacted]")
      .replace(/(?:\/Users\/|\/home\/|\/private\/|\/tmp\/)[^\s'"]+/gu, "<path>")
      .trim()
      .slice(0, 1000) || "Git command failed or timed out."
  );
}
export type GitFailure = Readonly<{ type: "offline" | "not-found" | "auth" | "timeout" | "other"; message: string }>;
export function classifyGitFailure(error: unknown): GitFailure {
  const message = redactGitDiagnostic(error);
  const killed = typeof error === "object" && error !== null && "killed" in error && error.killed;
  const type =
    killed || /timed? ?out|timeout/iu.test(message)
      ? "timeout"
      : /authentication|permission denied|could not read Username|403|401/iu.test(message)
        ? "auth"
        : /not found|does not exist|does not appear to be a git repository|404/iu.test(message)
          ? "not-found"
          : /could not resolve|failed to connect|network|unreachable|connection refused/iu.test(message)
            ? "offline"
            : "other";
  return { type, message };
}
function assertRemoteUrl(url: string): void {
  if (!url || url.startsWith("-") || /[\u0000-\u0020\u007f]/u.test(url))
    throw new Error("The external source destination is unsafe. Add a valid repository and check again.");
}
export async function cloneExternalReadCopy(parent: string, url: string, folder: string): Promise<void> {
  assertRemoteUrl(url);
  await runGitCommand(parent, ["clone", "--filter=blob:none", "--no-checkout", "--", url, folder], 60000);
  await checkoutExternalSkills(folder, "HEAD");
}
async function checkoutExternalSkills(folder: string, target: string): Promise<void> {
  const paths = (await runGitCommand(folder, ["ls-tree", "-r", "--name-only", "-z", target])).split("\0");
  const selected = new Set(paths.filter((path) => path.endsWith("/SKILL.md")).map((path) => path.slice(0, -9)));
  const escape = (path: string): string => path.replace(/[\\*?\[\]]/gu, "\\$&");
  const patterns = [...selected].map((path) => `/${escape(path)}/`);
  for (const path of paths)
    if (!path.includes("/") && /^(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$/iu.test(path))
      patterns.push(`/${escape(path)}`);
  await runGitCommand(folder, ["sparse-checkout", "set", "--no-cone", "--stdin"], 60000, `${patterns.join("\n")}\n`);
  await runGitCommand(folder, ["reset", "--hard", target], 60000);
}
export async function refreshExternalReadCopy(folder: string, url: string): Promise<void> {
  assertRemoteUrl(url);
  const details = await lstat(folder);
  const metadata = await lstat(`${folder}/.git`);
  if (!details.isDirectory() || details.isSymbolicLink() || !metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("The external read copy is unsafe. Restore its Omni folder and check again.");
  const refs = await runGitCommand(folder, ["ls-remote", "--symref", url, "HEAD"], 60000);
  const branch = /^ref: refs\/heads\/(.+)\tHEAD$/mu.exec(refs)?.[1];
  if (!branch || branch.startsWith("-") || branch.includes("..") || !/^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/u.test(branch))
    throw new Error("The external source has no safe remote default branch. Repair its HEAD and check again.");
  await runGitCommand(
    folder,
    ["fetch", "--prune", "--", url, `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    60000,
  );
  await checkoutExternalSkills(folder, `refs/remotes/origin/${branch}`);
}
