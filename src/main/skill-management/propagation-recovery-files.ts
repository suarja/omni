import { createHash } from "node:crypto";
import { join } from "node:path";

import { createSkillRevision } from "../../domain/skill-reconciliation/revisions";
import { createUnifiedDiff } from "../../domain/unified-diff";
import type { SkillLocationKey, SkillRevision } from "../../domain/skill-reconciliation/types";
import type { SkillEffectStep } from "../../shared/skill-management-ipc";
import type { SkillPropagationReceiptPointer } from "../../shared/skill-propagation-ipc";
import type { OperationAction } from "../../shared/operations-ipc";
import { listRegularFiles, readRegularFile } from "../operation-files";
import { SKILL_SCAN_BUDGET_BYTES } from "./adoption-reader";
import type { PropagationRecoveryDependencies } from "./propagation-recovery-types";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function exactRevision(files: ReadonlyMap<string, Uint8Array>): SkillRevision {
  return createSkillRevision(
    [...files].map(([path, bytes]) => ({ path, hash: sha256(bytes), byteLength: bytes.byteLength })),
    (value) => createHash("sha256").update(value).digest("hex"),
  );
}
export function revisionMatches(left: SkillRevision, right: SkillRevision): boolean {
  return left.algorithm === right.algorithm && left.hash === right.hash;
}
function withinBackup(args: PropagationRecoveryDependencies, pointer: SkillPropagationReceiptPointer): string {
  const backup = join(args.userDataPath, pointer.backupPath);
  if (!backup.startsWith(join(args.userDataPath, "omni/backups/skill-propagation") + "/"))
    throw new Error("The saved propagation backup path is outside its managed recovery folder.");
  return backup;
}
export async function readBackup(
  args: PropagationRecoveryDependencies,
  pointer: SkillPropagationReceiptPointer,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const root = withinBackup(args, pointer);
  const paths = await listRegularFiles(root, pointer.location.folderPath);
  if (paths.length > 512) throw new Error("The propagation backup exceeds the file limit.");
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const path of paths) {
    const bytes = await readRegularFile(root, path);
    if (!bytes) throw new Error("A verified propagation backup file is unavailable.");
    total += bytes.byteLength;
    if (total > SKILL_SCAN_BUDGET_BYTES) throw new Error("The propagation backup exceeds the byte limit.");
    files.set(path.slice(pointer.location.folderPath.length + 1), bytes);
  }
  if (!revisionMatches(exactRevision(files), pointer.beforeRevision))
    throw new Error("The propagation backup does not match its saved before revision.");
  return files;
}
export function changedFiles(
  location: SkillLocationKey,
  current: ReadonlyMap<string, Uint8Array>,
  previous: ReadonlyMap<string, Uint8Array>,
): Readonly<{ actions: readonly OperationAction[]; files: SkillEffectStep["files"] }> {
  const actions: OperationAction[] = [];
  const files: SkillEffectStep["files"][number][] = [];
  const paths = [...new Set([...current.keys(), ...previous.keys()])].sort((a, b) => a.localeCompare(b));
  for (const path of paths) {
    const before = current.get(path);
    const after = previous.get(path);
    if (before && after && Buffer.from(before).equals(Buffer.from(after))) continue;
    const relativePath = location.folderPath + "/" + path;
    const beforeHash = before ? sha256(before) : undefined;
    const afterHash = after ? sha256(after) : undefined;
    const kind = after ? ("write-file" as const) : ("delete-file" as const);
    const inverse = createUnifiedDiff(
      `${relativePath} (current)`,
      `${relativePath} (restored)`,
      before ?? new Uint8Array(),
      after ?? new Uint8Array(),
    );
    const byteLength = after?.byteLength ?? before?.byteLength ?? 0;
    const diff =
      inverse.text === "binary file differs"
        ? `${relativePath}: binary content ${after ? "restored" : "deleted"} (${byteLength} bytes).`
        : inverse.text;
    actions.push({
      kind,
      relativePath,
      ...(beforeHash ? { beforeHash } : {}),
      ...(afterHash ? { afterHash } : {}),
      byteLength,
      diff,
    });
    files.push({
      rootId: location.projectId,
      relativePath,
      change: !after ? "delete" : !before ? "add" : "change",
      ...(beforeHash ? { beforeHash } : {}),
      ...(afterHash ? { afterHash } : {}),
      byteLength,
      diff,
    });
  }
  return { actions, files };
}
