import { githubRepository } from "../../domain/storefront-origin";
import type { PublishPluginRequest } from "../../shared/publication-operations-ipc";
import type { OperationPlan } from "../../shared/operations-ipc";
import { classifyPublicationDrift } from "../../domain/publication-drift";
import { readRegularFile } from "../operation-files";
import {
  hashes,
  publicationFor,
  readTree,
  repositoryState,
  type PublicationContext,
  type PublicationOptions,
  type FileTree,
} from "./publish-context";
import { readBaseFiles, readCommittedFile } from "../git-read";
import {
  bytes,
  edit,
  retainCommitEdit,
  originText,
  manifestFrom,
  effectiveTree,
  diffStats,
  type PublicationEdit,
} from "./publish-content";
import type { WorkshopEvidence } from "./publish-reader";
import type { NewDestination, PublishStored } from "./publish-plan";
function mergeTrees(
  base: FileTree,
  storefront: FileTree,
  current: FileTree,
  choices: PublishPluginRequest["conflictChoices"],
): Readonly<{
  merged: Record<string, Uint8Array>;
  files: NonNullable<OperationPlan["publication"]>["files"];
  conflicts: string[];
}> {
  const actual = Object.assign(Object.create(null), storefront) as Record<string, Uint8Array>;
  delete actual["ORIGIN.md"];
  const drift = classifyPublicationDrift(hashes(base), hashes(actual), hashes(current));
  const conflicts = drift.files.filter((file) => file.classification === "conflict").map((file) => file.path);
  if (Object.keys(choices ?? {}).some((path) => !conflicts.includes(path)))
    throw new Error("Conflict choices must name current conflicting files only.");
  const merged: Record<string, Uint8Array> = Object.create(null);
  const files = drift.files.map((file) => {
    const choice = choices && Object.hasOwn(choices, file.path) ? choices[file.path] : undefined;
    const keep =
      file.classification === "storefront-only" || (file.classification === "conflict" && choice !== "take-workshop");
    const content = keep ? actual[file.path] : current[file.path];
    if (content !== undefined) merged[file.path] = content;
    return { ...file, ...diffStats(actual[file.path], content), ...(choice ? { choice } : {}) };
  });
  return { merged, files, conflicts };
}
export type PreparedPublication = Readonly<{
  state: Awaited<ReturnType<typeof repositoryState>>;
  storefront: FileTree;
  previous: PublishStored["previous"];
  merged: Record<string, Uint8Array>;
  files: NonNullable<OperationPlan["publication"]>["files"];
  conflicts: string[];
  edits: PublicationEdit[];
  committedAt: (path: string) => Promise<Uint8Array | undefined>;
}>;
export async function preparePublication(
  options: PublicationOptions,
  request: PublishPluginRequest,
  ctx: PublicationContext,
  source: WorkshopEvidence,
  root: string,
  storefrontId: string,
  date: string,
  destination?: NewDestination,
): Promise<PreparedPublication> {
  const { packagePath, raw, workshopCommit, repository, manifest } = source;
  const state = destination
    ? { head: "0".repeat(40), branch: "main", remoteUrl: destination.remoteUrl }
    : await repositoryState(root, options.git);
  const storefront: FileTree = destination ? Object.create(null) : await readTree(root, `plugins/${request.pluginId}`);
  const committedStorefront = destination
    ? Object.create(null)
    : await readBaseFiles(root, state.head, `plugins/${request.pluginId}`);
  if (!committedStorefront) throw new Error("The storefront commit is unavailable. Restore access to its history.");
  if (
    committedStorefront["omni.plugin.json"] ||
    (!destination && (await readRegularFile(root, `plugins/${request.pluginId}/omni.plugin.json`)))
  )
    throw new Error(
      "The storefront contains workshop-only plugin metadata. Preserve it outside the storefront before publishing.",
    );
  const committedAt = (path: string): Promise<Uint8Array | undefined> =>
    destination
      ? Promise.resolve(Object.hasOwn(destination.files, path) ? destination.files[path] : undefined)
      : readCommittedFile(root, state.head, path);
  const current = effectiveTree(raw, manifest);
  const previous = publicationFor(ctx.publications, storefrontId, request.pluginId);
  if (previous && previous.workshopPackagePath !== packagePath)
    throw new Error("The publication belongs to a different workshop package. Restore its source identity.");
  if (!previous && Object.keys(storefront).length)
    throw new Error(
      "The storefront plugin already exists without a publication record. Link its ORIGIN before updating.",
    );
  const baseRaw = previous
    ? await readBaseFiles(ctx.workshopRoot, previous.baseCommit, packagePath)
    : Object.create(null);
  if (!baseRaw) throw new Error("The publication base commit is unavailable. Restore its Git history.");
  const base = previous ? effectiveTree(baseRaw, manifestFrom(baseRaw["omni.plugin.json"])) : Object.create(null);
  const { merged, files, conflicts } = mergeTrees(base, storefront, current, request.conflictChoices);
  merged["ORIGIN.md"] = bytes(
    originText(githubRepository(repository)!, packagePath, workshopCommit, date, storefront["ORIGIN.md"]),
  );
  const edits: PublicationEdit[] = [];
  for (const path of new Set([
    ...Object.keys(storefront),
    ...Object.keys(merged),
    ...Object.keys(committedStorefront),
  ])) {
    const change =
      edit(`plugins/${request.pluginId}/${path}`, storefront[path], merged[path]) ??
      retainCommitEdit(`plugins/${request.pluginId}/${path}`, merged[path], committedStorefront[path]);
    if (change) edits.push(change);
  }
  return { state, storefront, previous, merged, files, conflicts, edits, committedAt };
}
