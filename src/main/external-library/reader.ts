import { basename, join } from "node:path";
import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { createLocalJsonRegistryStore } from "../../adapters/registry/local-json";
import type { ExternalSourceRecord } from "../../domain/external-sources";
import type { RegistryState } from "../../domain/project-source-registry";
import type { ExternalSource, ExternalSourceDetails, ExternalLibraryList } from "../../shared/external-library-ipc";
import { classifyGitFailure } from "../git-command";
import { detectExternalUses, type ExternalLockedUse } from "./detection";
import { externalReadCopyPath, type ExternalReadCopyOptions } from "./read-copy";
import { readExternalLicence, readExternalSkills, readExternalTree } from "./trees";
import { readExternalUse, type ExternalSourceObservation } from "./use-reader";
import { externalReadCopyFolder } from "../../domain/external-library";
import type { ExternalSourcesStore } from "./store";
import { createExternalCopyVersionResolver } from "./copy-version";

export type ExternalLibraryObservation = Readonly<{
  sources: ExternalSourceDetails[];
  lockedUses: ExternalLockedUse[];
  roots: Map<string, string>;
  observations: Map<string, ExternalSourceObservation>;
  diagnostics: ExternalLibraryList["diagnostics"];
}>;
export async function readExternalRegistry(options: ExternalReadCopyOptions): Promise<RegistryState> {
  const loaded = await createLocalJsonRegistryStore(
    join(options.userDataPath, "omni/project-source-registry.json"),
  ).read();
  if (loaded.status !== "ready")
    throw new Error("External library registrations are unavailable. Restore the registry and check again.");
  return loaded.state;
}
export function summarizeExternalSource(id: string, name: string, record?: ExternalSourceRecord): ExternalSource {
  return {
    id,
    kind: record ? "github" : "folder",
    name,
    arrival: record?.arrival ?? "owner",
    readCopy: record ? `omni/external-sources/${record.readCopyFolder}` : name,
    ...(record
      ? { repo: record.repo, lastCheckAt: record.lastCheckAt, head: record.head, lastError: record.lastError }
      : {}),
    licence: "none",
    skillCount: 0,
    unusedSkills: 0,
    counts: { "up-to-date": 0, update: 0, modified: 0, removed: 0, unknown: 0 },
    projects: [],
  };
}
export async function observeExternalLibrary(
  options: ExternalReadCopyOptions,
  store: ExternalSourcesStore,
): Promise<ExternalLibraryObservation> {
  const registry = await readExternalRegistry(options),
    detection = await detectExternalUses(registry);
  const diagnostics = detection.diagnostics.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const records = (await store.read()).sources;
  const resolveCopyVersion = await createExternalCopyVersionResolver(store);
  const folders = registry.sources.filter((source) => !source.archivedAt && source.ownership === "external");
  const candidates = [
    ...records.map((record) => ({
      view: summarizeExternalSource(record.repo, record.repo, record),
      root: externalReadCopyPath(options, record),
    })),
    ...folders.map((folder) => ({
      view: summarizeExternalSource(`folder:${folder.id}`, folder.displayName),
      root: folder.locator.canonicalPath,
    })),
  ];
  // A newly registered project's source is readable as unknown until the next explicit pass clones it.
  for (const locked of detection.uses)
    if (!candidates.some((candidate) => candidate.view.id === locked.entry.source.locator))
      candidates.push({
        view: summarizeExternalSource(locked.entry.source.locator, locked.entry.source.locator, {
          repo: locked.entry.source.locator,
          arrival: "detected",
          readCopyFolder: externalReadCopyFolder(locked.entry.source.locator),
        }),
        root: externalReadCopyPath(options, {
          repo: locked.entry.source.locator,
          arrival: "detected",
          readCopyFolder: externalReadCopyFolder(locked.entry.source.locator),
        }),
      });
  const sources: ExternalSourceDetails[] = [];
  const roots = new Map<string, string>();
  const observations = new Map<string, ExternalSourceObservation>();
  for (const { view, root } of candidates) {
    roots.set(view.id, root);
    let skills: ExternalSourceDetails["skills"] = [],
      failed = Boolean(view.lastError);
    try {
      view.licence = await readExternalLicence(createLocalInventoryPort(root));
      skills = await readExternalSkills(root, view.licence);
    } catch (error) {
      failed = true;
      view.lastError ??= classifyGitFailure(error);
    }
    const hashes = new Map<string, string | undefined>();
    for (const skill of skills) {
      try {
        hashes.set(skill.path, (await readExternalTree(root, skill.path))?.hash);
      } catch {
        hashes.set(skill.path, undefined);
      }
    }
    const observation = { id: view.id, root, skills, failed, hashes, removed: new Set<string>() };
    observations.set(view.id, observation);
    const uses = [] as ExternalSourceDetails["uses"];
    for (const locked of detection.uses.filter((use) => use.entry.source.locator === view.id)) {
      const use = await readExternalUse(locked, observation);
      uses.push(view.head ? await resolveCopyVersion(use, root, view.head.commit) : use);
    }
    for (const skill of skills) skill.useIds = uses.filter((use) => use.skillPath === skill.path).map((use) => use.id);
    for (const use of uses) view.counts[use.state]++;
    view.skillCount = skills.length;
    view.unusedSkills = skills.filter((skill) => !skill.useIds.length).length;
    view.projects = [
      ...new Map(uses.map((use) => [use.projectId, { id: use.projectId, name: use.projectName }])).values(),
    ];
    sources.push({ source: view, skills, uses });
  }
  return { sources, lockedUses: detection.uses, roots, observations, diagnostics };
}
