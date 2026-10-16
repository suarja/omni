import { basename, join, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { classifyExternalUse } from "../../domain/external-library";
import type { ExternalUse, ExternalSkill } from "../../shared/external-library-ipc";
import { readGitText } from "../git-read";
import { recoverExternalBase, type ExternalBaseOptions } from "./base-recovery";
import type { ExternalLockedUse } from "./detection";
import { readExternalTree, type ExternalTree } from "./trees";

export type ExternalSourceObservation = Readonly<{
  id: string;
  root: string;
  skills: readonly ExternalSkill[];
  failed: boolean;
  hashes: Map<string, string | undefined>;
  removed: Set<string>;
}>;
export async function readExternalBase(
  root: string,
  path: string,
  hash: string,
  maximum = 300,
  options: ExternalBaseOptions = {},
): Promise<ExternalUse["base"]> {
  return (await recoverExternalBase(root, path, hash, maximum, options)).base;
}
async function locateSourceSkill(
  use: ExternalLockedUse,
  source: ExternalSourceObservation,
): Promise<{
  path?: string;
  ambiguous?: boolean;
}> {
  const explicit = use.entry.sourceSkillPath?.replace(/\/SKILL\.md$/u, "");
  if (explicit) return { path: explicit };
  const current = source.skills.filter((skill) => basename(skill.path) === use.entry.skillKey);
  if (current.length === 1) return { path: current[0]!.path };
  if (current.length > 1) return { ambiguous: true };
  const deleted = await readGitText(source.root, [
    "log",
    "-300",
    "--diff-filter=D",
    "--format=",
    "--name-only",
    "--",
    `:(glob)**/${use.entry.skillKey}/SKILL.md`,
  ]);
  const paths = [
    ...new Set(
      (deleted ?? "")
        .split(/\r?\n/u)
        .filter((path) => path.endsWith("/SKILL.md"))
        .map((path) => path.slice(0, -9)),
    ),
  ];
  return paths.length === 1 ? { path: paths[0] } : { ambiguous: paths.length > 1 };
}
export async function readProjectExternalTree(root: string, folder: string): Promise<ExternalTree | undefined> {
  try {
    const canonicalRoot = await realpath(root),
      canonicalFolder = await realpath(join(root, folder));
    const path = relative(canonicalRoot, canonicalFolder);
    if (!path || path === ".." || path.startsWith("../") || resolve(canonicalRoot, path) !== canonicalFolder)
      return undefined;
    return await readExternalTree(canonicalRoot, path);
  } catch {
    return undefined;
  }
}
async function readProjectCopy(use: ExternalLockedUse): Promise<{ path?: string; tree?: ExternalTree }> {
  for (const prefix of [".agents", ".claude", ".codex"]) {
    const path = `${prefix}/skills/${use.entry.skillKey}`;
    try {
      await realpath(join(use.root, path));
      return { path, tree: await readProjectExternalTree(use.root, path) };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return { path };
    }
  }
  return {};
}
async function readRemoval(root: string, path: string): Promise<ExternalUse["removal"]> {
  const text = await readGitText(root, [
    "log",
    "--diff-filter=D",
    "-1",
    "--format=%H%n%cI%n%s",
    "--",
    `${path}/SKILL.md`,
  ]);
  if (!text) return undefined;
  const [commit, date, ...subject] = text.split(/\r?\n/u);
  if (!commit || !date || !Number.isFinite(Date.parse(date))) return undefined;
  return {
    commit,
    date: new Date(date).toISOString(),
    subject: subject
      .join(" ")
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .slice(0, 4096),
  };
}
export async function readExternalUse(
  use: ExternalLockedUse,
  source?: ExternalSourceObservation,
  copyFolder?: string,
): Promise<ExternalUse> {
  const copy = copyFolder
    ? { path: copyFolder, tree: await readProjectExternalTree(use.root, copyFolder) }
    : await readProjectCopy(use);
  const initial: ExternalUse = {
    id: use.id,
    sourceId: use.entry.source.locator,
    projectId: use.projectId,
    projectName: use.projectName,
    skillKey: use.entry.skillKey,
    lockHash: use.entry.recordedHash,
    ...(copy.path ? { folderPath: copy.path } : {}),
    ...(copy.tree ? { copyHash: copy.tree.hash } : {}),
    state: "unknown",
    sourceChanged: false,
    base: { status: "unknown", reason: "A complete source and project copy are required." },
  };
  const explicitPath = use.entry.sourceSkillPath?.replace(/\/SKILL\.md$/u, "");
  const matches = source?.skills.filter((skill) => basename(skill.path) === use.entry.skillKey);
  if (explicitPath) initial.skillPath = explicitPath;
  else if (matches?.length === 1) initial.skillPath = matches[0]!.path;
  if (!source || source.failed) return initial;
  try {
    const location = await locateSourceSkill(use, source);
    if (location.ambiguous)
      return { ...initial, diagnostic: "Multiple source folders match this skill. An exact skillPath is required." };
    const path = location.path;
    if (!path)
      return {
        ...initial,
        state: copy.tree ? "removed" : "unknown",
        sourceChanged: Boolean(copy.tree),
        diagnostic: "The source has no matching skill or recoverable deletion path.",
      };
    if (!source.hashes.has(path) && !source.removed.has(path)) {
      try {
        const entrypoint = await createLocalInventoryPort(source.root).lstat(`${path}/SKILL.md`);
        if (entrypoint.type !== "file") throw new Error("The source skill entrypoint is unsafe.");
        source.hashes.set(path, (await readExternalTree(source.root, path))?.hash);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "not-found")
          source.removed.add(path);
        else throw error;
      }
    }
    const removed = source.removed.has(path);
    const sourceHash = source.hashes.get(path);
    const decision = classifyExternalUse({
      lock: use.entry.recordedHash,
      copy: copy.tree?.hash,
      source: sourceHash,
      removed,
    });
    const removal = removed ? await readRemoval(source.root, path) : undefined;
    const base = initial.base;
    return {
      ...initial,
      ...decision,
      skillPath: path,
      ...(sourceHash ? { sourceHash } : {}),
      ...(removal ? { removal } : {}),
      base,
    };
  } catch {
    return { ...initial, diagnostic: "The source skill could not be read safely. Check its complete tree again." };
  }
}
