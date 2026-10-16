import { readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ExternalSkillIntent } from "../../shared/external-skill-intents";
import type { ExternalUse } from "../../shared/external-library-ipc";
import type { ExternalLockLine } from "../../domain/external-skill-lock";
import { editExternalSkillsLock } from "../../domain/external-skill-lock";
import { readRegularFile } from "../operation-files";
import { currentGrantRoot } from "../granted-hashing";
import { freshGrant } from "../skill-management/adoption-reader";
import { captureExactSkillTree, hashExactTree, type ExactSkillTree } from "../skill-management/project-skill-files";
import { fingerprintExternalFiles, readExternalTree } from "./trees";
import {
  hashExternalBytes,
  serializeExternalBackup,
  type ExternalOperationDependencies,
  type ExternalTargetPlan,
} from "./operation-types";

type Selection = Readonly<{
  name: string;
  path: string;
  use?: ExternalUse;
  harnessIds?: readonly ("codex" | "claude-code")[];
}>;
type Layout = ExternalTargetPlan["backup"]["layouts"][number];

function treeFiles(tree: ExactSkillTree): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const entry of tree) if (entry.kind === "file") files[entry.path] = Buffer.from(entry.data, "base64");
  return files;
}
function makeTree(files: Record<string, Uint8Array>, modes: ExactSkillTree): ExactSkillTree {
  const directories = new Set<string>(modes.filter((entry) => entry.kind === "directory").map((entry) => entry.path));
  for (const path of Object.keys(files)) {
    let parent = dirname(path);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  const mode = new Map(modes.map((entry) => [entry.path, entry.mode]));
  return [
    ...[...directories].sort().map((path) => ({ kind: "directory" as const, path, mode: mode.get(path) ?? 0o755 })),
    ...Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, bytes]) => ({
        kind: "file" as const,
        path,
        mode: mode.get(path) ?? 0o644,
        data: Buffer.from(bytes).toString("base64"),
      })),
  ].sort((a, b) => compareTreePaths(a.path, b.path));
}
// Exact capture visits sorted siblings recursively; flat path sorting puts app.png before app/page.ts.
function compareTreePaths(left: string, right: string): number {
  const a = left.split("/"),
    b = right.split("/");
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return a.length - b.length;
}
async function linkLayout(root: string): Promise<boolean> {
  const entries = await readdir(join(root, ".claude/skills")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of entries) {
    const path = `.claude/skills/${name}`,
      tree = await captureExactSkillTree(root, path);
    const link = tree?.[0];
    if (
      link?.kind === "symlink" &&
      !link.target.startsWith("/") &&
      resolve(root, dirname(path), link.target) === resolve(root, `.agents/skills/${name}`)
    )
      return true;
  }
  return false;
}
async function selectedLayouts(root: string, selection: Selection): Promise<Layout[]> {
  const codex = `.agents/skills/${selection.name}`,
    claude = `.claude/skills/${selection.name}`;
  const linked = await linkLayout(root);
  const paths = selection.harnessIds
    ? [
        ...new Set(
          selection.harnessIds.flatMap((agent) => (agent === "codex" ? [codex] : linked ? [codex, claude] : [claude])),
        ),
      ]
    : [codex, claude, `.codex/skills/${selection.name}`];
  const layouts: Layout[] = [];
  for (const path of paths) {
    const before = await captureExactSkillTree(root, path);
    if (!selection.harnessIds && !before) continue;
    if (before?.[0]?.kind === "symlink") {
      const link = before[0];
      if (
        path !== claude ||
        link.target.startsWith("/") ||
        resolve(root, dirname(path), link.target) !== resolve(root, codex)
      )
        throw new Error(`Project skill link ${path} is unsafe. Reconnect its canonical project copy.`);
    }
    layouts.push({
      path,
      harnessId: path.startsWith(".claude/") ? "claude-code" : "codex",
      ...(before ? { before: [...before] } : {}),
    });
  }
  return layouts;
}
async function mergeTree(
  args: ExternalOperationDependencies,
  intent: Extract<ExternalSkillIntent, { kind: "merge-external-skill" }>,
  use: ExternalUse,
  sourceTree: ExactSkillTree,
  localTree: ExactSkillTree,
): Promise<ExactSkillTree> {
  const comparison = await args.library.compare(use.id);
  if (comparison.base.status === "unknown")
    throw new Error("Merge evidence is unavailable. Check the source and refresh the comparison.");
  if (comparison.base.status === "not-found") {
    if (!intent.wholeCopy || intent.choices.length)
      throw new Error("The base was not found. Choose the whole local copy or source copy.");
    return intent.wholeCopy === "mine" ? localTree : sourceTree;
  }
  if (intent.wholeCopy) throw new Error("A recovered base requires per-file choices.");
  if (comparison.status !== "ready")
    throw new Error("Merge evidence changed. Check the source and refresh the comparison.");
  const mine = treeFiles(localTree),
    source = treeFiles(sourceTree),
    choices = new Map(intent.choices.map((choice) => [choice.path, choice.choice]));
  if (
    intent.choices.some(
      (choice) => !comparison.files.some((file) => file.path === choice.path && file.classification === "conflict"),
    )
  )
    throw new Error("Merge choices must name only the current conflicting files.");
  const files: Record<string, Uint8Array> = Object.assign(Object.create(null), mine);
  for (const file of comparison.files) {
    if (file.classification === "conflict" && !choices.has(file.path))
      throw new Error(`Choose mine or source for ${file.path}.`);
    const chooseSource =
      file.classification === "storefront-only" ||
      (file.classification === "conflict" && choices.get(file.path) === "source");
    const bytes = (chooseSource ? source : mine)[file.path];
    if (bytes !== undefined) files[file.path] = bytes;
    else delete files[file.path];
  }
  if (!Object.hasOwn(files, "SKILL.md")) throw new Error("A merged external skill must retain SKILL.md.");
  return makeTree(files, [...sourceTree, ...localTree]);
}

export async function planExternalSkillTargets(
  args: ExternalOperationDependencies,
  intent: ExternalSkillIntent,
  intentId: string,
): Promise<ExternalTargetPlan[]> {
  const observation = await args.library.operationObservation();
  const source = observation.sources.find((item) => item.source?.id === intent.sourceId);
  const sourceRoot = observation.roots.get(intent.sourceId);
  if (!source?.source?.head || source.source.lastError || !sourceRoot || source.source.kind !== "github")
    throw new Error("The external source has no checked HEAD. Check the library before installing or updating.");
  const selections = new Map<string, Selection[]>();
  if (intent.kind === "install-external-skill") {
    if (!source.skills.some((skill) => skill.path === intent.skillPath))
      throw new Error("The selected source skill is unavailable at the checked HEAD.");
    for (const target of intent.targets)
      selections.set(target.projectId, [
        { name: intent.skillName, path: intent.skillPath, harnessIds: target.harnessIds },
      ]);
  } else {
    for (const id of intent.kind === "update-external-skills" ? intent.useIds : [intent.useId]) {
      const use = source.uses.find((item) => item.id === id);
      const required = intent.kind === "update-external-skills" ? "update" : "modified";
      if (!use || use.state !== required || !use.skillPath || !use.folderPath || !use.copyHash || !use.sourceHash)
        throw new Error(`External use ${id} is not a verified ${required} copy. Check it and refresh the preview.`);
      const project = selections.get(use.projectId) ?? [];
      project.push({ name: use.skillKey, path: use.skillPath, use });
      selections.set(use.projectId, project);
    }
  }
  const result: ExternalTargetPlan[] = [];
  for (const [projectId, skills] of selections) {
    try {
      const grant = await freshGrant(args.registry, { kind: "project", id: projectId }, args.now ?? Date.now);
      if (!grant || !(await currentGrantRoot(grant)))
        throw new Error(`Reconnect project ${projectId} before writing its external skills.`);
      const lockBefore = await readRegularFile(grant.root, "skills-lock.json");
      const entries = new Map<string, ExternalLockLine>(),
        layouts: Layout[] = [],
        sources: { path: string; hash: string }[] = [];
      for (const skill of skills) {
        const sourceFiles = await readExternalTree(sourceRoot, skill.path);
        const exact = await captureExactSkillTree(sourceRoot, skill.path);
        const sourceHash = observation.observations.get(intent.sourceId)?.hashes.get(skill.path);
        if (
          !sourceFiles ||
          !exact ||
          !sourceHash ||
          sourceFiles.hash !== sourceHash ||
          exact.some((entry) => entry.kind === "symlink")
        )
          throw new Error("The source skill changed or contains an unsafe link. Check the source again.");
        const sourceTree = makeTree(sourceFiles.files, exact);
        sources.push({ path: skill.path, hash: sourceHash });
        const selected = await selectedLayouts(grant.root, skill);
        if (!selected.length) throw new Error(`Project ${projectId} no longer has its installed ${skill.name} copy.`);
        const localTree = selected.find((layout) => layout.before?.[0]?.kind !== "symlink" && layout.before)?.before;
        let nextTree: ExactSkillTree = sourceTree;
        if (intent.kind === "merge-external-skill")
          nextTree = await mergeTree(args, intent, skill.use!, sourceTree, localTree!);
        for (const layout of selected) {
          if (intent.kind === "install-external-skill" && layout.before && intent.conflict !== "replace")
            throw new Error(
              `Project ${projectId} already has ${layout.path}. Choose replace to back up this conflict.`,
            );
          if (
            skill.use &&
            layout.before?.[0]?.kind !== "symlink" &&
            (!layout.before || fingerprintExternalFiles(treeFiles(layout.before)) !== skill.use.copyHash)
          )
            throw new Error(`Project ${projectId} copy ${layout.path} changed since the check. Refresh the library.`);
          if (layout.before?.some((entry) => entry.kind === "symlink" && entry.path))
            throw new Error("Project skill contains an unsafe nested link.");
          const after: ExactSkillTree =
            layout.path.startsWith(".claude/") &&
            (layout.before?.[0]?.kind === "symlink" ||
              (!layout.before &&
                (await linkLayout(grant.root)) &&
                selected.some((item) => item.path.startsWith(".agents/"))))
              ? [
                  {
                    kind: "symlink",
                    path: "",
                    mode: 0o755,
                    target: relative(
                      dirname(join(grant.root, layout.path)),
                      join(grant.root, `.agents/skills/${skill.name}`),
                    ),
                  },
                ]
              : nextTree;
          layouts.push({ ...layout, after: [...after] });
        }
        entries.set(skill.name, {
          source: intent.sourceId,
          sourceType: "github",
          skillPath: skill.path,
          computedHash: sourceHash,
        });
      }
      const lockText = lockBefore === undefined ? undefined : Buffer.from(lockBefore).toString("utf8");
      const lockAfter = editExternalSkillsLock(lockText, entries);
      const stepId = hashExternalBytes(JSON.stringify([intentId, projectId]))!;
      result.push(
        serializeExternalBackup({
          evidence: {
            kind: intent.kind,
            projectId,
            sourceId: intent.sourceId,
            device: grant.device,
            inode: grant.inode,
            backupPath: `omni/backups/external-skills/${intentId}/${stepId}.json`,
            backupHash: "0".repeat(64),
            direction: "forward",
            copies: skills.length,
            layouts: layouts.map((layout) => ({
              path: layout.path,
              harnessId: layout.harnessId,
              beforeHash: hashExactTree(layout.before),
              afterHash: hashExactTree(layout.after),
            })),
            beforeLockHash: hashExternalBytes(lockText),
            afterLockHash: hashExternalBytes(lockAfter),
          },
          sources,
          sourceHead: source.source.head.commit,
          licence: source.source.licence,
          layouts,
          lockBefore: lockText,
          lockAfter,
        }),
      );
    } catch (error) {
      if (intent.kind !== "update-external-skills") throw error;
      const path = `.agents/skills/${skills[0]!.name}`;
      const refusal = (
        error instanceof Error ? error.message : "The project is unavailable. Reconnect it and refresh the library."
      )
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
        .slice(0, 4096);
      result.push(
        serializeExternalBackup({
          sources: [],
          layouts: [{ path, harnessId: "codex" }],
          evidence: {
            kind: intent.kind,
            projectId,
            sourceId: intent.sourceId,
            device: "0",
            inode: "0",
            direction: "forward",
            copies: skills.length,
            refusal,
            backupHash: "0".repeat(64),
            backupPath: `omni/backups/external-skills/${intentId}/${hashExternalBytes(JSON.stringify([intentId, projectId]))!}.json`,
            layouts: [{ path, harnessId: "codex" }],
          },
        }),
      );
    }
  }
  return result;
}
