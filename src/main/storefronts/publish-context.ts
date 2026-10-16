import { parseRegistryState, type SourceRegistration } from "../../domain/project-source-registry";
import type { ProjectSourceRegistryStore } from "../../ports/project-source-registry";
import type { PublicationsStore } from "./publications-store";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createLocalJsonRegistryStore } from "../../adapters/registry/local-json";
import { activeStorefronts, activeWorkshop } from "../../domain/source-roles";
import type { Publication } from "../../domain/publications";
import type { GitCli } from "../git-cli";
import type { GhCli } from "../gh-cli";
import type { OperationStore } from "../operation-store";
import type { FileWriter } from "../operation-files";
import { hashContent } from "../marketplace-manifests";
import { readPluginHashes } from "./files";
import { readRegularFile } from "../operation-files";
import { readGitText } from "../git-read";
import { createPublicationsStore, publicationsFilePath } from "./publications-store";
export type PublicationOptions = Readonly<{
  userDataPath: string;
  operationStore: OperationStore;
  git: GitCli;
  gh?: GhCli;
  now?: () => number;
  homeDirectory?: string;
  fileWriter?: FileWriter;
}>;
export type FileTree = Readonly<Record<string, Uint8Array>>;
export function hashes(files: FileTree): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, hashContent(content)]));
}
export function sameHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  return JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
}
export function stores(
  options: PublicationOptions,
): Readonly<{ registry: ProjectSourceRegistryStore; publications: PublicationsStore }> {
  return {
    registry: createLocalJsonRegistryStore(join(options.userDataPath, "omni/project-source-registry.json")),
    publications: createPublicationsStore(publicationsFilePath(options.userDataPath)),
  };
}
export type PublicationContext = Readonly<{
  workshop: SourceRegistration;
  workshopRoot: string;
  storefront: SourceRegistration | undefined;
  root: string | undefined;
  publications: readonly Publication[];
  revision: number;
}>;
export async function context(options: PublicationOptions, storefrontId?: string): Promise<PublicationContext> {
  const { registry, publications } = stores(options);
  const [registered, saved, operations] = await Promise.all([
    registry.read(),
    publications.read(),
    options.operationStore.read(),
  ]);
  if (registered.status !== "ready" || saved.status !== "ready" || operations.status !== "ready")
    throw new Error("Recover the registry, publications and operations stores before publishing.");
  await publications.assertFresh();
  const diskRegistry = await readRegularFile(options.userDataPath, "omni/project-source-registry.json");
  if (
    !diskRegistry ||
    JSON.stringify(parseRegistryState(JSON.parse(Buffer.from(diskRegistry).toString("utf8")))) !==
      JSON.stringify(registered.state)
  )
    throw new Error("The registry changed locally. Reload it before publishing.");
  const workshop = activeWorkshop(registered.state);
  const storefront = activeStorefronts(registered.state).find((source) => source.id === storefrontId);
  if (!workshop || (storefrontId && !storefront))
    throw new Error("Connect the active workshop and requested storefront before publishing.");
  const workshopRoot = await regularRoot(workshop.locator.canonicalPath);
  const root = storefront && (await regularRoot(storefront.locator.canonicalPath));
  return {
    workshop,
    workshopRoot,
    storefront,
    root,
    publications: saved.publications,
    revision: registered.state.revision,
  };
}
async function regularRoot(path: string): Promise<string> {
  const node = await lstat(path);
  if (!node.isDirectory() || node.isSymbolicLink()) throw new Error("Publication roots must be regular directories.");
  return realpath(path);
}
export async function rootIdentity(root: string): Promise<string> {
  const stat = await lstat(root);
  return `${await realpath(root)}:${stat.dev}:${stat.ino}`;
}
export async function readTree(root: string, folder: string): Promise<FileTree> {
  const expected = await readPluginHashes(root, folder);
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const [path, hash] of Object.entries(expected)) {
    const bytes = await readRegularFile(root, `${folder}/${path}`);
    if (!bytes || hashContent(bytes) !== hash)
      throw new Error("Publication files changed while reading. Preview again.");
    files[path] = bytes;
  }
  return files;
}
export async function repositoryState(
  root: string,
  git: GitCli,
): Promise<Readonly<{ head: string; branch: string; remoteUrl: string }>> {
  if (!(await git.isRepositoryRoot(root))) throw new Error("Publication requires the storefront repository root.");
  const [head, branch, remoteUrl] = await Promise.all([
    git.headCommit(root),
    readGitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git.remoteUrl(root),
  ]);
  if (!head || !branch || !remoteUrl)
    throw new Error("Publication requires a local commit, attached branch and origin remote.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) || branch.includes("..") || branch.endsWith(".lock"))
    throw new Error("The publication branch name is unsafe.");
  return { head, branch, remoteUrl };
}
export function publicationFor(
  records: readonly Publication[],
  sourceId: string,
  pluginId: string,
): Publication | undefined {
  return records.find((record) => record.storefrontSourceId === sourceId && record.pluginId === pluginId);
}
