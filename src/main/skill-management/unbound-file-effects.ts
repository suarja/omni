import { randomUUID, createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { SkillJournalAction } from "../../application/skill-management-journal";
import { currentGrantRoot } from "../granted-hashing";
import { safePath } from "../operation-files";
import type { RegistryGrant } from "../registry-ipc";
type Progress = (actions: readonly SkillJournalAction[]) => Promise<void>;

export function bytesHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function nodeIdentity(details: { dev: bigint; ino: bigint }): string {
  return `${details.dev}:${details.ino}`;
}

async function targetPath(grant: RegistryGrant, relativePath: string): Promise<string> {
  if (!(await currentGrantRoot(grant))) throw new Error("The selected project root changed before a file effect.");
  const target = await safePath(grant.root, relativePath);
  let parent = grant.root;
  for (const part of relativePath.split("/").slice(0, -1)) {
    parent = join(parent, part);
    const details = await lstat(parent);
    if (details.isSymbolicLink() || !details.isDirectory())
      throw new Error(`The selected file has a linked or non-directory ancestor: ${relativePath}`);
  }
  return target;
}

function append(actions: SkillJournalAction[], action: SkillJournalAction): void {
  const index = actions.findIndex(
    (candidate) => candidate.relativePath === action.relativePath && candidate.kind === action.kind,
  );
  if (index < 0) actions.push(action);
  else actions[index] = action;
}

async function currentFile(target: string): Promise<Readonly<{ identity: string; hash: string }> | undefined> {
  const details = await lstat(target, { bigint: true }).catch((error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      ? undefined
      : Promise.reject(error),
  );
  if (!details) return undefined;
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("A reviewed file path is no longer a regular file.");
  const bytes = Uint8Array.from(await readFile(target));
  return { identity: nodeIdentity(details), hash: bytesHash(bytes) };
}

export async function writeOwnedFile(
  args: Readonly<{
    grant: RegistryGrant;
    relativePath: string;
    beforeHash?: string;
    beforeIdentity?: string;
    bytes: Uint8Array;
    actions: SkillJournalAction[];
    progress: Progress;
    beforeEffect: (temporaryPath: string) => Promise<void>;
  }>,
): Promise<string> {
  const target = await targetPath(args.grant, args.relativePath);
  const before = await currentFile(target);
  if (before?.hash !== args.beforeHash || before?.identity !== args.beforeIdentity)
    throw new Error(`The reviewed local file changed before replacement: ${args.relativePath}`);
  const temporary = join(dirname(target), `.omni-link-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(args.bytes);
    await handle.sync();
    const details = await handle.stat({ bigint: true });
    const identity = nodeIdentity(details);
    await handle.chmod(0o644);
    await handle.close();
    handle = undefined;
    const temporaryPath = relative(args.grant.root, temporary).split("\\").join("/");
    append(args.actions, {
      relativePath: args.relativePath,
      kind: "write-file",
      status: "applying",
      ...(args.beforeHash ? { beforeHash: args.beforeHash } : {}),
      afterHash: bytesHash(args.bytes),
      identity,
      temporaryPath,
    });
    await args.progress(args.actions);
    await args.beforeEffect(temporaryPath);
    const freshTarget = await targetPath(args.grant, args.relativePath);
    const current = await currentFile(freshTarget);
    if (current?.hash !== args.beforeHash || current?.identity !== args.beforeIdentity)
      throw new Error(`The reviewed local file changed after progress: ${args.relativePath}`);
    // Publishing an absent path must atomically reject a concurrent writer, not replace it.
    if (args.beforeHash === undefined) await link(temporary, freshTarget);
    else await rename(temporary, freshTarget);
    await unlink(temporary).catch(() => undefined);
    await chmod(freshTarget, 0o644);
    const applied = await lstat(freshTarget, { bigint: true });
    if (nodeIdentity(applied) !== identity) throw new Error("The written file identity changed before verification.");
    append(args.actions, {
      relativePath: args.relativePath,
      kind: "write-file",
      status: "applied",
      ...(args.beforeHash ? { beforeHash: args.beforeHash } : {}),
      afterHash: bytesHash(args.bytes),
      identity,
    });
    await args.progress(args.actions);
    return identity;
  } catch (error: unknown) {
    throw error;
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

export async function deleteOwnedFile(
  args: Readonly<{
    grant: RegistryGrant;
    relativePath: string;
    beforeHash: string;
    beforeIdentity: string;
    actions: SkillJournalAction[];
    progress: Progress;
    beforeEffect: () => Promise<void>;
  }>,
): Promise<void> {
  const target = await targetPath(args.grant, args.relativePath);
  const before = await currentFile(target);
  if (!before || before.hash !== args.beforeHash || before.identity !== args.beforeIdentity)
    throw new Error(`The reviewed local file changed before deletion: ${args.relativePath}`);
  append(args.actions, {
    relativePath: args.relativePath,
    kind: "delete-file",
    status: "applying",
    beforeHash: args.beforeHash,
    identity: args.beforeIdentity,
  });
  await args.progress(args.actions);
  await args.beforeEffect();
  const freshTarget = await targetPath(args.grant, args.relativePath);
  const current = await currentFile(freshTarget);
  if (!current || current.hash !== args.beforeHash || current.identity !== args.beforeIdentity)
    throw new Error(`The reviewed local file changed after progress: ${args.relativePath}`);
  await unlink(freshTarget);
  append(args.actions, {
    relativePath: args.relativePath,
    kind: "delete-file",
    status: "applied",
    beforeHash: args.beforeHash,
    identity: args.beforeIdentity,
  });
  await args.progress(args.actions);
}

export async function createOwnedDirectory(
  args: Readonly<{
    grant: RegistryGrant;
    relativePath: string;
    actions: SkillJournalAction[];
    progress: Progress;
    beforeEffect: (temporaryPath: string) => Promise<void>;
  }>,
): Promise<string> {
  const target = await targetPath(args.grant, args.relativePath);
  append(args.actions, {
    relativePath: args.relativePath,
    kind: "create-directory",
    status: "applying",
  });
  await args.progress(args.actions);
  await args.beforeEffect("");
  const freshTarget = await targetPath(args.grant, args.relativePath);
  // rename() can replace a foreign empty directory; mkdir() rejects any occupied path.
  await mkdir(freshTarget, { mode: 0o755 });
  const applied = await lstat(freshTarget, { bigint: true });
  if (applied.isSymbolicLink() || !applied.isDirectory())
    throw new Error("The created directory changed before verification.");
  const identity = nodeIdentity(applied);
  append(args.actions, { relativePath: args.relativePath, kind: "create-directory", status: "applied", identity });
  await args.progress(args.actions);
  return identity;
}

export async function removeOwnedDirectory(
  args: Readonly<{
    grant: RegistryGrant;
    relativePath: string;
    identity: string;
    actions: SkillJournalAction[];
    progress: Progress;
    beforeEffect: () => Promise<void>;
  }>,
): Promise<void> {
  const target = await targetPath(args.grant, args.relativePath);
  const verify = async (): Promise<void> => {
    const details = await lstat(target, { bigint: true });
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      nodeIdentity(details) !== args.identity ||
      (await readdir(target)).length !== 0
    )
      throw new Error(`The operation-created directory is no longer owned and empty: ${args.relativePath}`);
  };
  await verify();
  append(args.actions, {
    relativePath: args.relativePath,
    kind: "remove-directory",
    status: "applying",
    identity: args.identity,
  });
  await args.progress(args.actions);
  await args.beforeEffect();
  await targetPath(args.grant, args.relativePath);
  await verify();
  await rmdir(target);
  append(args.actions, {
    relativePath: args.relativePath,
    kind: "remove-directory",
    status: "applied",
    identity: args.identity,
  });
  await args.progress(args.actions);
}
