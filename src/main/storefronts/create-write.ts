import { pushWithEvidence, savePushOutcome } from "./push-evidence";
import { execFile } from "../../adapters/owned-child-processes";
import { mkdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { registerSource } from "../../domain/project-source-registry";
import type { OperationApplyProvenance, OperationReceipt, ApplyOperationResponse } from "../../shared/operations-ipc";
import { safeGitArgs } from "../safe-git-args";
import { systemGhCli } from "../gh-cli";
import { writeAtomically } from "../operation-files";
import { stores, type PublicationOptions } from "./publish-context";
import { errorText, persistReceipt } from "./publish-write";
import type { CreateStored } from "./create-plan";
const exec = promisify(execFile);
async function git(root: string, args: readonly string[]): Promise<void> {
  await exec("git", safeGitArgs(args), {
    cwd: root,
    shell: false,
    timeout: 15000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}
type StorefrontCreateProgress = Readonly<{
  appliedAt: string;
  commit: string | undefined;
  diagnostic: string | undefined;
  pushed: boolean;
  registered: boolean;
  remote: string;
  uncertain: boolean;
  completed: readonly string[];
}>;
function buildCreationReceipt(
  stored: CreateStored,
  { appliedAt, commit, diagnostic, pushed, registered, remote, uncertain, completed }: StorefrontCreateProgress,
  provenance?: OperationApplyProvenance,
): OperationReceipt {
  return {
    operationId: stored.operationId,
    kind: "create-storefront",
    status: pushed && registered && !diagnostic ? "applied" : "failed",
    appliedAt,
    displayTarget: stored.input.name,
    actions: stored.plan.actions.map((action) => ({
      ...action,
      status: completed.includes(action.relativePath) ? "applied" : "failed",
    })),
    git: { mode: "init-and-commit", ...(commit ? { commit } : {}) },
    registered: registered ? { sourceId: stored.sourceId } : null,
    publication: {
      state: pushed ? "pushed" : commit && registered && !uncertain ? "committed-not-pushed" : "failed",
      storefrontId: stored.sourceId,
      branch: "main",
      remoteUrl: remote,
    },
    ...(diagnostic ? { diagnostic } : {}),
    ...(provenance ? { provenance } : {}),
  };
}
async function registerCreatedStorefront(
  options: PublicationOptions,
  stored: CreateStored,
  appliedAt: string,
): Promise<void> {
  const { registry } = stores(options);
  const loaded = await registry.read();
  if (loaded.status !== "ready")
    throw new Error(
      "The storefront was created, but its registry is unavailable. Preserve the folder and recover the registry.",
    );
  const canonicalPath = await realpath(stored.root);
  const decision = registerSource(loaded.state, {
    id: stored.sourceId,
    displayName: stored.input.name,
    canonicalPath,
    ownership: "personal",
    role: "storefront",
    createdAt: appliedAt,
  });
  if (decision.result.status !== "ready" || decision.result.outcome === "existing")
    throw new Error("The storefront registration changed during creation. Preserve the created folder.");
  const saved = await registry.mutate(loaded.state.revision, () => decision.nextState);
  if (saved.status !== "ready")
    throw new Error("The storefront registry changed. Preserve the folder and link it again.");
}
export async function writeStorefront(
  options: PublicationOptions,
  stored: CreateStored,
  provenance?: OperationApplyProvenance,
): Promise<ApplyOperationResponse> {
  const appliedAt = new Date((options.now ?? Date.now)()).toISOString();
  let commit: string | undefined;
  let diagnostic: string | undefined;
  let pushed = false;
  let registered = false;
  let remote = stored.remoteUrl;
  let uncertain = false;
  const completed: string[] = [];
  let ghEvidence: OperationReceipt | undefined;
  const receipt = (): OperationReceipt =>
    buildCreationReceipt(
      stored,
      { appliedAt, commit, diagnostic, pushed, registered, remote, uncertain, completed },
      provenance,
    );
  try {
    await mkdir(stored.root, { recursive: false, mode: 0o755 });
    for (const [path, content] of Object.entries(stored.files)) {
      await writeAtomically(stored.root, path, content, options.fileWriter, () => completed.push(path));
    }
    await git(stored.root, ["init", "-q", "-b", "main"]);
    const result = await options.git.initAndCommit(stored.root, `Create storefront ${stored.input.name}`);
    if (result.status !== "committed") throw new Error(result.diagnostic);
    commit = result.commit;
    await registerCreatedStorefront(options, stored, appliedAt);
    registered = true;
    if (stored.usesGh) {
      // repoCreate includes the initial push, so failure leaves an uncertain external result.
      uncertain = true;
      diagnostic = "The storefront is created locally; GitHub creation has not completed.";
      ghEvidence = receipt();
      await persistReceipt(options, ghEvidence);
      const created = await (options.gh ?? systemGhCli).repoCreate(`${stored.login}/${stored.input.name}`, stored.root);
      if (created.status !== "created") throw new Error(created.diagnostic);
      pushed = true;
      uncertain = false;
      remote = (await options.git.remoteUrl(stored.root)) ?? remote;
    } else {
      await git(stored.root, ["remote", "add", "origin", stored.input.repositoryUrl!]);
      diagnostic = "The storefront is committed locally; push has not completed.";
      await persistReceipt(options, receipt());
      return await pushWithEvidence(options, receipt(), stored.root);
    }
    diagnostic = undefined;
  } catch (error) {
    diagnostic = errorText(error);
  }
  return ghEvidence ? savePushOutcome(options, receipt(), ghEvidence) : persistReceipt(options, receipt());
}
