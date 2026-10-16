import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isMissing } from "./fs-optional";

export type FileWriter = (
  path: string,
  content: string | Uint8Array,
  options: { encoding?: BufferEncoding; mode?: number },
) => Promise<void>;

function within(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance === "" || (distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance));
}
function safeRelative(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Operation path is unsafe.");
  return normalized;
}

async function nearestExisting(path: string): Promise<string | undefined> {
  let current = path;
  while (true) {
    try {
      return await realpath(current);
    } catch (error: unknown) {
      if (!isMissing(error)) return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

export async function safePath(root: string, relativePath: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const normalized = safeRelative(relativePath);
  const lexical = resolve(canonicalRoot, normalized);
  if (!within(canonicalRoot, lexical)) throw new Error("Operation path escapes the project root.");
  const ancestor = await nearestExisting(lexical);
  if (ancestor && !within(canonicalRoot, ancestor)) throw new Error("Operation path escapes the project root.");
  const details = await lstat(lexical).catch((error: unknown) =>
    isMissing(error) ? undefined : Promise.reject(error),
  );
  if (details?.isSymbolicLink()) throw new Error("Operation target must not be a symlink.");
  return lexical;
}

export async function ensureDirectories(root: string, relativePath: string): Promise<void> {
  const path = await safePath(root, relativePath);
  await mkdir(path, { recursive: true, mode: 0o755 });
  await chmod(path, 0o755);
}

export async function writeAtomically(
  root: string,
  relativePath: string,
  content: string | Uint8Array,
  writer: FileWriter = async (path, value, options) => writeFile(path, value, options),
  onReplaced?: () => void,
): Promise<void> {
  const path = await safePath(root, relativePath);
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o755 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writer(temporary, content, { encoding: typeof content === "string" ? "utf8" : undefined, mode: 0o644 });
    await chmod(temporary, 0o644);
    await rename(temporary, path);
    onReplaced?.();
    await chmod(path, 0o644);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readRegularFile(root: string, relativePath: string): Promise<Uint8Array | undefined> {
  const path = await safePath(root, relativePath);
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) return undefined;
    return readFile(path);
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function listRegularFiles(root: string, relativePath: string): Promise<readonly string[]> {
  const path = await safePath(root, relativePath);
  const details = await lstat(path).catch((error: unknown) => (isMissing(error) ? undefined : Promise.reject(error)));
  if (!details) return [];
  if (details.isFile() && !details.isSymbolicLink()) return [relativePath];
  if (!details.isDirectory() || details.isSymbolicLink())
    throw new Error("Operation target must be a regular file or directory.");
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Operation target contains a symlink.");
    const child = `${relativePath}/${entry.name}`;
    result.push(...(await listRegularFiles(root, child)));
  }
  return result.sort();
}

export async function backupFiles(
  projectRoot: string,
  backupRoot: string,
  relativePaths: readonly string[],
): Promise<void> {
  for (const relativePath of relativePaths) {
    const source = await safePath(projectRoot, relativePath);
    const details = await lstat(source);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Only regular files can be backed up.");
    const target = join(backupRoot, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, await readFile(source), { mode: 0o644 });
    await chmod(target, 0o644);
  }
}

export async function restoreBackup(projectRoot: string, backupRoot: string, relativePath: string): Promise<boolean> {
  const backup = join(backupRoot, relativePath);
  const content = await readFile(backup).catch((error: unknown) =>
    isMissing(error) ? undefined : Promise.reject(error),
  );
  if (!content) return false;
  await writeAtomically(projectRoot, relativePath, content);
  return true;
}

export async function removeFileOrEmptyDirectories(
  projectRoot: string,
  relativePath: string,
  stopRelative: string,
): Promise<void> {
  const path = await safePath(projectRoot, relativePath);
  await rm(path, { force: true });
  let current = dirname(path);
  const stop = resolve(projectRoot, stopRelative);
  while (current !== stop && within(stop, current)) {
    try {
      await rmdir(current);
    } catch {
      break;
    }
    current = dirname(current);
  }
}

export async function removeDirectoryIfEmpty(projectRoot: string, relativePath: string): Promise<void> {
  const path = await safePath(projectRoot, relativePath);
  await rm(path, { recursive: false, force: true });
}

export async function symlinkTarget(root: string, relativePath: string): Promise<string | undefined> {
  const path = await safePath(root, relativePath);
  try {
    return (await lstat(path)).isSymbolicLink() ? await readlink(path, "utf8") : undefined;
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
