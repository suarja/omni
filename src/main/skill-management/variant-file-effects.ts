import { randomUUID, createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillJournalAction } from "../../application/skill-management-journal";
import { currentGrantRoot } from "../granted-hashing";
import { safePath } from "../operation-files";
import type { RegistryGrant } from "../registry-ipc";

export type Progress = (actions: readonly SkillJournalAction[]) => Promise<void>;
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function resolveVariantPath(grant: RegistryGrant, relativePath: string): Promise<string> {
  if (!(await currentGrantRoot(grant)))
    throw new Error("The registered source root changed during variant publication.");
  const target = await safePath(grant.root, relativePath);
  let ancestor = grant.root;
  for (const part of relativePath.split("/").slice(0, -1)) {
    ancestor = join(ancestor, part);
    const details = await lstat(ancestor);
    if (details.isSymbolicLink() || !details.isDirectory())
      throw new Error(`Variant path has a linked or non-directory ancestor: ${relativePath}`);
  }
  return target;
}

export function appendAction(actions: SkillJournalAction[], action: SkillJournalAction): SkillJournalAction[] {
  const index = actions.findIndex((entry) => entry.relativePath === action.relativePath && entry.kind === action.kind);
  if (index < 0) actions.push(action);
  else actions[index] = action;
  return actions;
}

export async function createDirectory(
  grant: RegistryGrant,
  relativePath: string,
  actions: SkillJournalAction[],
  progress: Progress,
): Promise<Readonly<{ created: boolean; identity?: string }>> {
  await progress(appendAction(actions, { relativePath, kind: "create-directory", status: "applying" }));
  const target = await resolveVariantPath(grant, relativePath);
  try {
    await mkdir(target, { mode: 0o755 });
    const details = await lstat(target, { bigint: true });
    const identity = `${details.dev}:${details.ino}`;
    await progress(appendAction(actions, { relativePath, kind: "create-directory", status: "applied", identity }));
    return { created: true, identity };
  } catch (error: unknown) {
    await progress(appendAction(actions, { relativePath, kind: "create-directory", status: "failed" }));
    throw error;
  }
}

export async function writeExclusiveFile(
  grant: RegistryGrant,
  relativePath: string,
  bytes: Uint8Array,
  actions: SkillJournalAction[],
  progress: Progress,
): Promise<void> {
  await progress(
    appendAction(actions, { relativePath, kind: "write-file", status: "applying", afterHash: hash(bytes) }),
  );
  const target = await resolveVariantPath(grant, relativePath);
  let handle;
  let identity: string | undefined;
  try {
    handle = await open(target, "wx", 0o644);
    const details = await handle.stat({ bigint: true });
    identity = `${details.dev}:${details.ino}`;
    await progress(
      appendAction(actions, {
        relativePath,
        kind: "write-file",
        status: "applying",
        afterHash: hash(bytes),
        identity: `${details.dev}:${details.ino}`,
      }),
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o644);
    await progress(
      appendAction(actions, {
        relativePath,
        kind: "write-file",
        status: "applied",
        afterHash: hash(bytes),
        identity: `${details.dev}:${details.ino}`,
      }),
    );
  } catch (error: unknown) {
    await progress(
      appendAction(actions, {
        relativePath,
        kind: "write-file",
        status: "failed",
        afterHash: hash(bytes),
        ...(identity ? { identity } : {}),
      }),
    );
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function replaceReviewedFile(
  grant: RegistryGrant,
  relativePath: string,
  beforeHash: string,
  bytes: Uint8Array,
  kind: "write-manifest" | "restore-manifest",
  actions: SkillJournalAction[],
  progress: Progress,
  beforeEffect?: () => Promise<void>,
): Promise<void> {
  await progress(appendAction(actions, { relativePath, kind, status: "applying", beforeHash, afterHash: hash(bytes) }));
  await beforeEffect?.();
  const target = await resolveVariantPath(grant, relativePath);
  const current = Uint8Array.from(await readFile(target));
  if (hash(current) !== beforeHash) throw new Error("The reviewed plugin manifest changed before publication.");
  const temporary = join(dirname(target), `.omni-variant-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o644);
    await handle.close();
    handle = undefined;
    if (hash(Uint8Array.from(await readFile(target))) !== beforeHash)
      throw new Error("The reviewed plugin manifest changed during publication.");
    await beforeEffect?.();
    await resolveVariantPath(grant, relativePath);
    await rename(temporary, target);
    await chmod(target, 0o644);
    await progress(
      appendAction(actions, { relativePath, kind, status: "applied", beforeHash, afterHash: hash(bytes) }),
    );
  } catch (error: unknown) {
    await progress(appendAction(actions, { relativePath, kind, status: "failed", beforeHash, afterHash: hash(bytes) }));
    throw error;
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}
