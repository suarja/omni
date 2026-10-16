import { rm, mkdir, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RegistryGrant } from "../registry-ipc";
import { readRegularFile, safePath, writeAtomically } from "../operation-files";
import {
  captureExactSkillTree,
  hashExactTree,
  hashProjectSkillValue,
  materializeExactSkillTree,
  guardSkillPath,
  pathExists,
  removeExactSkillTree,
  type ExactSkillTree,
} from "../skill-management/project-skill-files";
import { freshGrant } from "../skill-management/adoption-reader";
import { currentGrantRoot } from "../granted-hashing";
import { readExternalTree } from "./trees";
import {
  externalBackupSchema,
  hashExternalBytes,
  serializeExternalBackup,
  type ExternalBackup,
  type ExternalTargetPlan,
  type ExternalOperationDependencies,
} from "./operation-types";
import type { ExternalSkillEvidence } from "../../shared/external-skill-effects";

export async function readExternalBackup(
  args: Pick<ExternalOperationDependencies, "userDataPath">,
  evidence: ExternalSkillEvidence,
): Promise<ExternalTargetPlan> {
  const bytes = await readRegularFile(args.userDataPath, evidence.backupPath);
  if (!bytes) throw new Error("The external skill backup is unavailable. Inspect operation recovery.");
  const backup = externalBackupSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  const parsed = serializeExternalBackup(backup);
  if (
    parsed.backup.evidence.backupHash !== evidence.backupHash ||
    hashProjectSkillValue(backup.evidence) !== hashProjectSkillValue(evidence)
  )
    throw new Error("The external skill backup digest does not match the approved operation.");
  if (
    backup.layouts.length !== evidence.layouts.length ||
    backup.layouts.some((layout, index) => {
      const item = evidence.layouts[index];
      return (
        item?.path !== layout.path ||
        item.harnessId !== layout.harnessId ||
        item.beforeHash !== hashExactTree(layout.before) ||
        item.afterHash !== hashExactTree(layout.after)
      );
    }) ||
    hashExternalBytes(backup.lockBefore) !== evidence.beforeLockHash ||
    hashExternalBytes(backup.lockAfter) !== evidence.afterLockHash
  )
    throw new Error("The external backup paths or hashes do not match their saved evidence.");
  return parsed;
}
export async function externalProjectGrant(
  args: ExternalOperationDependencies,
  backup: ExternalBackup,
): Promise<RegistryGrant> {
  const evidence = backup.evidence;
  const grant = await freshGrant(args.registry, { kind: "project", id: evidence.projectId }, args.now ?? Date.now);
  if (!grant || !(await currentGrantRoot(grant)) || grant.device !== evidence.device || grant.inode !== evidence.inode)
    throw new Error(
      `Project ${evidence.projectId} changed identity or is unavailable. Reconnect the original project.`,
    );
  return grant;
}
export async function validateExternalTarget(
  args: ExternalOperationDependencies,
  plan: ExternalTargetPlan,
): Promise<RegistryGrant> {
  const backup = plan.backup;
  if (backup.evidence.refusal) throw new Error(backup.evidence.refusal);
  const grant = await externalProjectGrant(args, backup);
  if (backup.evidence.direction === "forward") {
    const observed = await args.library.operationObservation();
    const source = observed.sources.find((entry) => entry.source?.id === backup.evidence.sourceId)?.source;
    const root = observed.roots.get(backup.evidence.sourceId);
    if (!source || !root || source.lastError || source.head?.commit !== backup.sourceHead)
      throw new Error("The checked external source changed or became unavailable. Refresh the operation preview.");
    for (const expected of backup.sources)
      if ((await readExternalTree(root, expected.path))?.hash !== expected.hash)
        throw new Error("The external source files changed after preview. Check the library again.");
  }
  for (const layout of backup.layouts)
    if (hashExactTree(await captureExactSkillTree(grant.root, layout.path)) !== hashExactTree(layout.before))
      throw new Error(
        `Project ${backup.evidence.projectId} copy ${layout.path} changed after preview. Its bytes were retained.`,
      );
  if (hashExternalBytes(await readRegularFile(grant.root, "skills-lock.json")) !== hashExternalBytes(backup.lockBefore))
    throw new Error(`Project ${backup.evidence.projectId} lock changed after preview. Refresh the operation.`);
  return grant;
}
async function replaceTree(
  args: ExternalOperationDependencies,
  root: string,
  path: string,
  before: ExactSkillTree | undefined,
  after: ExactSkillTree | undefined,
  mutated: () => void,
): Promise<void> {
  if (hashExactTree(before) === hashExactTree(after)) return;
  if (before) {
    await removeExactSkillTree(root, path, hashExactTree(before)!);
    mutated();
  }
  if (after) {
    mutated();
    await materializeExternalTree(args, root, path, after);
  }
}
async function materializeExternalTree(
  args: ExternalOperationDependencies,
  root: string,
  path: string,
  tree: ExactSkillTree,
): Promise<void> {
  if (tree[0]?.kind === "symlink") return materializeExactSkillTree(root, path, tree);
  const target = await guardSkillPath(root, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  for (const entry of tree) {
    const relativePath = entry.path ? `${path}/${entry.path}` : path;
    const destination = await guardSkillPath(root, relativePath);
    if (entry.kind === "symlink") throw new Error("External skill files cannot contain nested links.");
    if (entry.kind === "directory") await mkdir(destination, { mode: 0o700 });
    else {
      if (await pathExists(destination))
        throw new Error("A project file appeared during the external write. Inspect recovery.");
      await writeAtomically(root, relativePath, Buffer.from(entry.data, "base64"), args.fileWriter);
    }
  }
  for (const entry of [...tree].reverse()) await chmod(join(target, entry.path), entry.mode);
}
async function replaceLock(args: ExternalOperationDependencies, root: string, text: string | undefined): Promise<void> {
  if (text === undefined) await rm(await safePath(root, "skills-lock.json"), { force: true });
  else await writeAtomically(root, "skills-lock.json", text, args.fileWriter);
}
export async function writeExternalTarget(
  args: ExternalOperationDependencies,
  grant: RegistryGrant,
  plan: ExternalTargetPlan,
  mutated: () => void,
): Promise<void> {
  for (const layout of plan.backup.layouts) {
    if (!(await currentGrantRoot(grant))) throw new Error("The project root changed during the external skill write.");
    await replaceTree(args, grant.root, layout.path, layout.before, layout.after, mutated);
  }
  if (
    hashExternalBytes(await readRegularFile(grant.root, "skills-lock.json")) !==
    hashExternalBytes(plan.backup.lockBefore)
  )
    throw new Error("The project lock changed during the external skill write.");
  if (plan.backup.lockBefore !== plan.backup.lockAfter) {
    mutated();
    await replaceLock(args, grant.root, plan.backup.lockAfter);
  }
  for (const layout of plan.backup.layouts)
    if (hashExactTree(await captureExactSkillTree(grant.root, layout.path)) !== hashExactTree(layout.after))
      throw new Error("The external skill files did not verify after writing. Inspect operation recovery.");
  if (
    hashExternalBytes(await readRegularFile(grant.root, "skills-lock.json")) !==
    hashExternalBytes(plan.backup.lockAfter)
  )
    throw new Error("The external skill lock did not verify after writing. Inspect operation recovery.");
}
export function isKnownExternalPartial(
  tree: ExactSkillTree | undefined,
  before: ExactSkillTree | undefined,
  after: ExactSkillTree | undefined,
): boolean {
  if (!tree || hashExactTree(tree) === hashExactTree(before) || hashExactTree(tree) === hashExactTree(after))
    return true;
  const entries = new Map([...(before ?? []), ...(after ?? [])].map((entry) => [entry.path, entry]));
  return tree.every((entry) => {
    const expected = entries.get(entry.path);
    return (
      expected &&
      entry.kind === expected.kind &&
      (entry.kind === "directory"
        ? entry.mode === expected.mode || entry.mode === 0o700
        : JSON.stringify(entry) === JSON.stringify(expected))
    );
  });
}
export async function rollbackExternalTarget(
  args: ExternalOperationDependencies,
  grant: RegistryGrant,
  plan: ExternalTargetPlan,
): Promise<boolean> {
  try {
    if (!(await currentGrantRoot(grant))) return false;
    const current = await Promise.all(
      plan.backup.layouts.map((layout) => captureExactSkillTree(grant.root, layout.path)),
    );
    const lock = await readRegularFile(grant.root, "skills-lock.json"),
      lockHash = hashExternalBytes(lock);
    if (lockHash !== hashExternalBytes(plan.backup.lockBefore) && lockHash !== hashExternalBytes(plan.backup.lockAfter))
      return false;
    if (
      !current.every((tree, index) =>
        isKnownExternalPartial(tree, plan.backup.layouts[index]!.before, plan.backup.layouts[index]!.after),
      )
    )
      return false;
    for (let index = 0; index < current.length; index++) {
      const layout = plan.backup.layouts[index]!;
      await replaceTree(
        { ...args, fileWriter: undefined },
        grant.root,
        layout.path,
        current[index],
        layout.before,
        () => undefined,
      );
    }
    // Rollback uses the ordinary writer, independent of an injected failed forward writer.
    await replaceLock({ ...args, fileWriter: undefined }, grant.root, plan.backup.lockBefore);
    return (
      hashExternalBytes(await readRegularFile(grant.root, "skills-lock.json")) ===
        hashExternalBytes(plan.backup.lockBefore) &&
      (
        await Promise.all(
          plan.backup.layouts.map(
            async (layout) =>
              hashExactTree(await captureExactSkillTree(grant.root, layout.path)) === hashExactTree(layout.before),
          ),
        )
      ).every(Boolean)
    );
  } catch {
    return false;
  }
}
