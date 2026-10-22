import { readGitText, readGitTextOrThrow } from "../git-read";
import { runGitCommand, redactGitDiagnostic } from "../git-command";
import { resolveRepositoryPushUrl, publicRepositoryUrl } from "../git-push";
import type { WorkshopPushResult, WorkshopSyncState } from "../../shared/workshop-delivery-ipc";

const sha = /^[a-f0-9]{40,64}$/u;
type Target = Readonly<{ branch: string; remote: string; ref: string; url: string; head: string }>;
async function readTarget(root: string): Promise<Target | undefined> {
  const branch = await readGitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) return undefined;
  const remote = await readGitText(root, ["config", "--get", `branch.${branch}.remote`]);
  const ref = await readGitText(root, ["config", "--get", `branch.${branch}.merge`]);
  if (!remote || !ref) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote) || !ref.startsWith("refs/heads/"))
    throw new Error("Workshop upstream is unsafe. Configure one branch upstream and retry.");
  await runGitCommand(root, ["check-ref-format", ref]);
  const urls = (await readGitTextOrThrow(root, ["remote", "get-url", "--push", "--all", remote]))?.split(/\r?\n/u);
  if (!urls || urls.length !== 1 || !urls[0] || urls[0].startsWith("-") || /[\s\u0000-\u001f]/u.test(urls[0]))
    throw new Error("Workshop push needs one safe destination. Repair the upstream and retry.");
  if (!/^(?:https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/\/|\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)/u.test(urls[0]))
    throw new Error("Workshop push transport is unsupported. Use HTTPS, SSH or a local repository and retry.");
  if ((await resolveRepositoryPushUrl(root, urls[0])) !== urls[0])
    throw new Error("Workshop push destination would be rewritten. Repair the upstream and retry.");
  const head = await readGitTextOrThrow(root, ["rev-parse", "HEAD"]);
  if (!head || !sha.test(head)) throw new Error("Workshop HEAD is unavailable. Repair Git and retry.");
  return { branch, remote, ref, url: urls[0], head };
}
async function readRemoteHead(root: string, target: Target): Promise<string | undefined> {
  const refs = await runGitCommand(root, ["ls-remote", "--refs", "--", target.url, target.ref]);
  return refs
    .split(/\r?\n/u)
    .find((line) => line.endsWith(`\t${target.ref}`))
    ?.split("\t")[0];
}
async function observeTarget(root: string, target: Target): Promise<WorkshopSyncState> {
  const upstream = `${target.remote}/${target.ref.slice(11)}`;
  const destination = publicRepositoryUrl(target.url);
  const pushedCommit = await readRemoteHead(root, target);
  if (!pushedCommit || !sha.test(pushedCommit))
    return {
      status: "ahead",
      ahead: Number(await readGitText(root, ["rev-list", "--count", target.head])) || 0,
      behind: 0,
      head: target.head,
      branch: target.branch,
      upstream,
      destination,
      diagnostic: "The upstream branch does not exist yet. Retry push to create it.",
    };
  if (pushedCommit === target.head)
    return {
      status: "current",
      ahead: 0,
      behind: 0,
      head: target.head,
      pushedCommit,
      branch: target.branch,
      upstream,
      destination,
    };
  const counts = await readGitText(root, ["rev-list", "--left-right", "--count", `${target.head}...${pushedCommit}`]);
  if (!counts || !/^\d+\s+\d+$/u.test(counts))
    return {
      status: "unavailable",
      ahead: 0,
      behind: 0,
      head: target.head,
      pushedCommit,
      branch: target.branch,
      upstream,
      destination,
      diagnostic:
        "The remote changed and its history is unavailable locally. Fetch the upstream and retry; Omni never rewrites history.",
    };
  const [ahead, behind] = counts.split(/\s+/u).map(Number) as [number, number];
  return {
    status: ahead && behind ? "diverged" : ahead ? "ahead" : "behind",
    ahead,
    behind,
    head: target.head,
    pushedCommit,
    branch: target.branch,
    upstream,
    destination,
  };
}
type ConfirmedPush = Readonly<{ commit: string; destination?: string }>;
export async function readWorkshopSync(root: string, confirmed?: ConfirmedPush): Promise<WorkshopSyncState> {
  let target: Target | undefined;
  try {
    target = await readTarget(root);
    if (!target)
      return {
        status: "no-upstream",
        ahead: 0,
        behind: 0,
        diagnostic: "The workshop has no branch upstream. Configure its Git remote and upstream, then retry.",
      };
    return await observeTarget(root, target);
  } catch (error) {
    const cached =
      target &&
      confirmed?.destination === publicRepositoryUrl(target.url) &&
      (await readGitText(root, ["rev-list", "--left-right", "--count", `HEAD...${confirmed.commit}`]));
    const [ahead, behind] = cached && /^\d+\s+\d+$/u.test(cached) ? cached.split(/\s+/u).map(Number) : [0, 0];
    return {
      status: "unavailable",
      ahead: ahead!,
      behind: behind!,
      diagnostic: redactGitDiagnostic(error),
      ...(target
        ? {
            head: target.head,
            branch: target.branch,
            upstream: `${target.remote}/${target.ref.slice(11)}`,
            destination: publicRepositoryUrl(target.url),
          }
        : {}),
    };
  }
}
export async function pushWorkshop(
  root: string,
  expected?: WorkshopSyncState,
  confirmed?: ConfirmedPush,
): Promise<WorkshopPushResult> {
  const head = await readGitText(root, ["rev-parse", "HEAD"]);
  if (!head || !sha.test(head)) throw new Error("Workshop HEAD is unavailable. Repair Git and retry.");
  let state = await readWorkshopSync(root, confirmed);
  let attempted = false;
  const failure = (diagnostic: string): WorkshopPushResult => ({
    status: "failed",
    commit: head,
    ahead: state.ahead,
    behind: state.behind,
    ...(state.upstream ? { upstream: state.upstream } : {}),
    ...(state.destination ? { destination: state.destination } : {}),
    diagnostic,
  });
  try {
    const target = await readTarget(root);
    if (!target) return failure(state.diagnostic!);
    if (
      expected &&
      (expected.head !== state.head ||
        expected.upstream !== state.upstream ||
        expected.destination !== state.destination ||
        expected.pushedCommit !== state.pushedCommit)
    )
      return failure("The workshop or upstream changed after preview. Preview Retry again.");
    if (state.status === "unavailable") return failure(state.diagnostic!);
    if (state.behind)
      return failure(
        "The workshop is behind or diverged. Omni never rewrites history. Reconcile the upstream manually, then retry.",
      );
    if (state.status !== "current") {
      attempted = true;
      await runGitCommand(
        root,
        [
          "push",
          "--porcelain",
          "--no-follow-tags",
          "--recurse-submodules=no",
          "--",
          target.url,
          `${head}:${target.ref}`,
        ],
        30000,
      );
    }
    const remoteHead = await readRemoteHead(root, target);
    if (remoteHead !== head)
      return {
        ...failure("The remote push outcome could not be confirmed. Check the upstream before retrying."),
        status: "unknown",
      };
    state = { ...state, ahead: 0, behind: 0 };
    return {
      status: "pushed",
      commit: head,
      ahead: 0,
      behind: 0,
      upstream: state.upstream,
      destination: state.destination,
    };
  } catch (error) {
    const diagnostic = redactGitDiagnostic(error);
    if (attempted) {
      try {
        const target = await readTarget(root);
        const remoteHead = target && (await readRemoteHead(root, target));
        if (remoteHead === head)
          return {
            status: "pushed",
            commit: head,
            ahead: 0,
            behind: 0,
            upstream: state.upstream,
            destination: state.destination,
            diagnostic,
          };
        if (remoteHead === state.pushedCommit) return failure(diagnostic);
      } catch {
        /* Transport may have succeeded before acknowledgement was lost. */
      }
      return {
        ...failure(diagnostic + " The remote outcome could not be confirmed. Check it before retrying."),
        status: "unknown",
      };
    }
    return failure(diagnostic);
  }
}
