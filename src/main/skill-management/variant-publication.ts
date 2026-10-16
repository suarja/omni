import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SkillJournalAction } from "../../application/skill-management-journal";
import type { SkillObservationFilesystem, SkillObservationGrant } from "../../ports/skill-reconciliation";
import type { SkillRevision } from "../../domain/skill-reconciliation/types";
import { parsePackageManifest } from "../../domain/marketplace-format";
import { currentGrantRoot } from "../granted-hashing";
import type { RegistryGrant } from "../registry-ipc";
import { observationGrant } from "./adoption-reader";
import {
  resolveVariantPath,
  appendAction,
  createDirectory,
  writeExclusiveFile,
  replaceReviewedFile,
  type Progress,
} from "./variant-file-effects";
import { variantPayloadFolder, type PreparedVariantPayload } from "./variant-payload";
export { prepareVariantPayload, readPreparedVariantPayload } from "./variant-payload";
export type { PreparedVariantPayload } from "./variant-payload";

export type PublishedFile = Readonly<{ relativePath: string; hash: string; byteLength: number }>;
export type PublicationReceipt = Readonly<{
  files: readonly PublishedFile[];
  directories: readonly string[];
  manifest: Readonly<{ relativePath: string; beforeHash: string; afterHash: string }>;
}>;
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

async function observePublishedTree(
  filesystem: SkillObservationFilesystem,
  grant: SkillObservationGrant,
  folderPath: string,
): Promise<Readonly<{ entries: readonly string[]; files: ReadonlyMap<string, Uint8Array> }>> {
  const entries: string[] = [];
  const files = new Map<string, Uint8Array>();
  const visit = async (path: string): Promise<void> => {
    const node = await filesystem.lstat(grant, path);
    const prefix = `${folderPath}/`;
    const relativePath = path === folderPath ? "" : path.slice(prefix.length);
    if (relativePath) entries.push(`${node.kind === "directory" ? "d" : "f"}:${relativePath}`);
    if (node.kind === "symlink" || node.kind === "other")
      throw new Error("The captured destination contains an unsafe entry.");
    if (node.kind === "directory") {
      const children = [...(await filesystem.listDirectory(grant, path))].sort((left, right) =>
        left.localeCompare(right),
      );
      for (const name of children) await visit(`${path}/${name}`);
      return;
    }
    if (node.byteLength > 1024 * 1024) throw new Error("The captured destination exceeds the file limit.");
    const read = await filesystem.readFile(grant, path, node.identity, 1024 * 1024);
    const after = await filesystem.lstat(grant, path);
    if (
      read.identity !== node.identity ||
      after.identity !== node.identity ||
      after.kind !== "file" ||
      read.bytes.byteLength !== node.byteLength
    )
      throw new Error("The captured destination changed during verification.");
    files.set(relativePath, Uint8Array.from(read.bytes));
    if (files.size > 512) throw new Error("The captured destination exceeds the file limit.");
  };
  await visit(folderPath);
  return { entries: entries.sort((left, right) => left.localeCompare(right)), files };
}

function expectedEntries(payload: PreparedVariantPayload, folderPath: string): string[] {
  const files = payload.index.files.map(({ relativePath }) => `f:${relativePath.slice(folderPath.length + 1)}`);
  const directories = payload.index.directories
    .filter((path) => path.startsWith(`${folderPath}/`))
    .map((path) => `d:${path.slice(folderPath.length + 1)}`);
  return [...files, ...directories].sort((left, right) => left.localeCompare(right));
}

function verifyTree(
  observed: Awaited<ReturnType<typeof observePublishedTree>>,
  payload: PreparedVariantPayload,
  folderPath: string,
): boolean {
  if (!sameEntries(observed.entries, expectedEntries(payload, folderPath))) return false;
  return payload.index.files.every((entry) => {
    const bytes = observed.files.get(entry.relativePath.slice(folderPath.length + 1));
    return bytes !== undefined && bytes.byteLength === entry.byteLength && hash(bytes) === entry.hash;
  });
}

export async function publishVariantCapture(
  args: Readonly<{
    grant: RegistryGrant;
    filesystem: SkillObservationFilesystem;
    payload: PreparedVariantPayload;
    skillsDirectoryPresent: boolean;
    progress: Progress;
  }>,
): Promise<PublicationReceipt> {
  const grant = args.grant;
  const payload = args.payload;
  const manifestAfterHash = payload.index.manifest.afterHash;
  const folderPath = variantPayloadFolder(payload);
  if (!folderPath) throw new Error("The captured skill folder is missing from the verified payload.");
  if (!(await currentGrantRoot(grant))) throw new Error("The selected source root changed before variant capture.");
  const actions: SkillJournalAction[] = [];
  const createdDirectories: string[] = [];
  const dirs = [...payload.index.directories].sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  );
  for (const path of dirs) {
    const isSkillsRoot = path === folderPath.split("/").slice(0, -1).join("/");
    if (isSkillsRoot && args.skillsDirectoryPresent) {
      const target = await resolveVariantPath(grant, path);
      if (!(await lstat(target)).isDirectory()) throw new Error("The selected skills folder changed before capture.");
      continue;
    }
    const result = await createDirectory(grant, path, actions, args.progress);
    if (result.created) createdDirectories.push(path);
  }
  const sourceRoot = grant.root;
  for (const entry of payload.index.files) {
    const bytes = payload.files.get(entry.relativePath);
    if (!bytes || hash(bytes) !== entry.hash) throw new Error("A prepared skill file failed its content hash.");
    await writeExclusiveFile(grant, entry.relativePath, bytes, actions, args.progress);
  }
  if (!(await currentGrantRoot(grant)))
    throw new Error("The selected source root changed before manifest publication.");
  await replaceReviewedFile(
    grant,
    payload.index.manifest.relativePath,
    payload.index.manifest.beforeHash,
    payload.manifestAfter,
    "write-manifest",
    actions,
    args.progress,
  );
  const afterManifest = Uint8Array.from(await readFile(join(sourceRoot, payload.index.manifest.relativePath)));
  if (hash(afterManifest) !== manifestAfterHash) throw new Error("The published plugin manifest failed verification.");
  const parsed = parsePackageManifest(JSON.parse(Buffer.from(afterManifest).toString("utf8")) as unknown);
  const expectedManifest = parsePackageManifest(
    JSON.parse(Buffer.from(payload.manifestAfter).toString("utf8")) as unknown,
  );
  const packagePrefix =
    payload.index.manifest.relativePath === "omni.plugin.json"
      ? ""
      : payload.index.manifest.relativePath.slice(0, -"/omni.plugin.json".length);
  const artifactPath = packagePrefix ? folderPath.slice(packagePrefix.length + 1) : folderPath;
  const entry = parsed.artifacts.filter((artifact) => artifact.path === artifactPath && artifact.kind === "skill");
  const expectedEntry = expectedManifest.artifacts.filter(
    (artifact) => artifact.path === artifactPath && artifact.kind === "skill",
  );
  if (
    entry.length !== 1 ||
    expectedEntry.length !== 1 ||
    !entry[0]?.variantOrigin ||
    JSON.stringify(entry[0].variantOrigin) !== JSON.stringify(expectedEntry[0]?.variantOrigin)
  )
    throw new Error("The per-skill origin did not verify in its exact manifest entry.");
  const tree = await observePublishedTree(args.filesystem, observationGrant(grant), folderPath);
  if (!verifyTree(tree, payload, folderPath))
    throw new Error("The published skill tree differs from the captured byte snapshot.");
  return {
    files: payload.index.files.map(({ relativePath, hash: fileHash, byteLength }) => ({
      relativePath,
      hash: fileHash,
      byteLength,
    })),
    directories: createdDirectories,
    manifest: payload.index.manifest,
  };
}

export async function verifyVariantAfterTree(
  args: Readonly<{
    grant: RegistryGrant;
    filesystem: SkillObservationFilesystem;
    payload: PreparedVariantPayload;
    afterManifestHash: string;
  }>,
): Promise<boolean> {
  const folderPath = variantPayloadFolder(args.payload);
  if (!folderPath || !(await currentGrantRoot(args.grant))) return false;
  try {
    const manifest = Uint8Array.from(await readFile(join(args.grant.root, args.payload.index.manifest.relativePath)));
    if (hash(manifest) !== args.afterManifestHash) return false;
    const tree = await observePublishedTree(args.filesystem, observationGrant(args.grant), folderPath);
    return verifyTree(tree, args.payload, folderPath);
  } catch {
    return false;
  }
}

export async function restoreVariantPublication(
  args: Readonly<{
    grant: RegistryGrant;
    payload: PreparedVariantPayload;
    createdDirectories: readonly Readonly<{ relativePath: string; identity: string }>[];
    presentFiles?: readonly string[];
    progress: Progress;
    beforeEffect?: () => Promise<void>;
  }>,
): Promise<void> {
  const actions: SkillJournalAction[] = [];
  if (!(await currentGrantRoot(args.grant))) throw new Error("The selected source root changed before restore.");
  const selectedFiles = args.presentFiles ? new Set(args.presentFiles) : undefined;
  for (const entry of [...args.payload.index.files]
    .reverse()
    .filter(({ relativePath }) => !selectedFiles || selectedFiles.has(relativePath))) {
    await args.progress(
      appendAction(actions, {
        relativePath: entry.relativePath,
        kind: "delete-file",
        status: "applying",
        beforeHash: entry.hash,
      }),
    );
    await args.beforeEffect?.();
    const target = await resolveVariantPath(args.grant, entry.relativePath);
    const details = await lstat(target, { bigint: true });
    if (!details.isFile() || details.isSymbolicLink())
      throw new Error("A captured variant file changed before restore.");
    const bytes = Uint8Array.from(await readFile(target));
    if (hash(bytes) !== entry.hash || bytes.byteLength !== entry.byteLength)
      throw new Error("A captured variant file changed before restore.");
    await unlink(target);
    await args.progress(
      appendAction(actions, {
        relativePath: entry.relativePath,
        kind: "delete-file",
        status: "applied",
        beforeHash: entry.hash,
        identity: `${details.dev}:${details.ino}`,
      }),
    );
  }
  await args.beforeEffect?.();
  const currentManifest = Uint8Array.from(
    await readFile(await resolveVariantPath(args.grant, args.payload.index.manifest.relativePath)),
  );
  if (hash(currentManifest) === args.payload.index.manifest.afterHash) {
    await replaceReviewedFile(
      args.grant,
      args.payload.index.manifest.relativePath,
      args.payload.index.manifest.afterHash,
      args.payload.manifestBefore,
      "restore-manifest",
      actions,
      args.progress,
      args.beforeEffect,
    );
  } else if (hash(currentManifest) !== args.payload.index.manifest.beforeHash) {
    throw new Error("The plugin manifest changed after variant capture; restore is withheld.");
  }
  for (const directory of [...args.createdDirectories].sort(
    (left, right) =>
      right.relativePath.split("/").length - left.relativePath.split("/").length ||
      right.relativePath.localeCompare(left.relativePath),
  )) {
    const { relativePath: path, identity } = directory;
    await args.progress(appendAction(actions, { relativePath: path, kind: "remove-directory", status: "applying" }));
    await args.beforeEffect?.();
    const target = await resolveVariantPath(args.grant, path);
    const details = await lstat(target, { bigint: true });
    if (`${details.dev}:${details.ino}` !== identity || details.isSymbolicLink() || !details.isDirectory())
      throw new Error("An operation-created directory changed identity; restore is withheld.");
    const entries = await readdir(target);
    if (entries.length)
      throw new Error("An operation-created directory now contains unexpected files; restore is withheld.");
    await rmdir(target);
    await args.progress(
      appendAction(actions, { relativePath: path, kind: "remove-directory", status: "applied", identity }),
    );
  }
}

export function preparedPayloadMatchesRevision(payload: PreparedVariantPayload, revision: SkillRevision): boolean {
  const folder = variantPayloadFolder(payload);
  return (
    payload.index.files.length === revision.files.length &&
    revision.files.every((file) => {
      const found = payload.index.files.find(({ relativePath }) => relativePath === `${folder}/${file.path}`);
      return found?.hash === file.hash && found.byteLength === file.byteLength;
    })
  );
}
