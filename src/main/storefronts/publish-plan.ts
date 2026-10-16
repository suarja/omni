import { projectPublicationChecks } from "./publish-check-projection";
import { buildPublicationEvidence } from "./publish-evidence";
import { preparePublication } from "./publish-merge";
import { buildStorefrontControls } from "./publish-controls";
import { previewPublicationActions, buildPublicationPreview } from "./publish-preview";
import { readWorkshopEvidence } from "./publish-reader";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { checkPublication } from "../../domain/publish-checks";
import type { Publication } from "../../domain/publications";
import type { PublishPluginRequest } from "../../shared/publication-operations-ipc";
import type { OperationPlan } from "../../shared/operations-ipc";
import { readRegularFile } from "../operation-files";
import { context, type FileTree, type PublicationOptions } from "./publish-context";
import type { PublicationEdit } from "./publish-content";
export type { PublicationEdit } from "./publish-content";
export type PublishStored = Readonly<{
  plan: OperationPlan;
  request: PublishPluginRequest;
  root: string;
  storefrontId: string;
  workshopRoot: string;
  workshopName: string;
  packagePath: string;
  workshopCommit: string;
  branch: string;
  remoteUrl: string;
  head: string;
  fingerprint: string;
  merged: FileTree;
  edits: readonly PublicationEdit[];
  previous?: Publication;
  operationId: string;
  children?: readonly string[];
}>;
export type NewDestination = Readonly<{
  root: string;
  sourceId: string;
  files: FileTree;
  remoteUrl: string;
  fingerprint: string;
}>;
export async function buildPublishPlan(
  options: PublicationOptions,
  request: PublishPluginRequest,
  operationId: string = randomUUID(),
  date = new Date((options.now ?? Date.now)()).toISOString(),
  destination?: NewDestination,
): Promise<PublishStored> {
  if (!request.storefrontId && !destination) throw new Error("Create the new storefront before publishing its plugin.");
  const ctx = await context(options, destination ? undefined : request.storefrontId);
  const root = destination?.root ?? ctx.root!;
  const storefrontId = destination?.sourceId ?? request.storefrontId!;
  const fileAt = (path: string): Promise<Uint8Array | undefined> =>
    destination
      ? Promise.resolve(Object.hasOwn(destination.files, path) ? destination.files[path] : undefined)
      : readRegularFile(root, path);
  const source = await readWorkshopEvidence(options, request, ctx.workshopRoot);
  const { packagePath, workshopCommit, manifest } = source;
  const prepared = await preparePublication(options, request, ctx, source, root, storefrontId, date, destination);
  const { state, previous, merged, files, conflicts, edits, committedAt } = prepared;
  const controlFiles = await buildStorefrontControls(
    root,
    request.pluginId,
    manifest,
    fileAt,
    committedAt,
    previous ? `plugins/${request.pluginId}` : undefined,
    destination,
  );
  const { license } = controlFiles;
  edits.push(...controlFiles.edits);
  const checkFiles = [...projectPublicationChecks(merged, `plugins/${request.pluginId}`), ...controlFiles.checkFiles];
  const findings = checkPublication({
    files: checkFiles,
    hasLicense: Boolean(license?.length),
    homeDirectory: options.homeDirectory ?? homedir(),
  });
  const views = previewPublicationActions(
    edits,
    `plugins/${request.pluginId}/ORIGIN.md`,
    options.homeDirectory ?? homedir(),
  );
  const { fingerprint, approvalFingerprint } = await buildPublicationEvidence(
    ctx,
    source,
    root,
    storefrontId,
    prepared,
    controlFiles,
    destination,
  );
  const plan = buildPublicationPreview(
    request.pluginId,
    views,
    files,
    conflicts.filter((path) => !request.conflictChoices || !Object.hasOwn(request.conflictChoices, path)),
    findings,
    approvalFingerprint,
  );
  return {
    plan,
    request,
    root,
    storefrontId,
    workshopRoot: ctx.workshopRoot,
    workshopName: ctx.workshop.displayName,
    packagePath,
    workshopCommit,
    ...state,
    fingerprint,
    merged,
    edits,
    previous,
    operationId,
  };
}
