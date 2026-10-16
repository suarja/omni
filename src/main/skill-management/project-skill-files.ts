import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lchmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";

const pathSchema = z
  .string()
  .max(1024)
  .refine(
    (path) =>
      path === "" ||
      (!path.startsWith("/") &&
        !path.includes("\\") &&
        !path.includes("\0") &&
        path.split("/").every((part) => part && part !== "." && part !== "..")),
  );
const entrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), path: pathSchema, mode: z.number().int().min(0).max(0o7777) }).strict(),
  z
    .object({
      kind: z.literal("file"),
      path: pathSchema,
      mode: z.number().int().min(0).max(0o7777),
      data: z.string().max(24 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("symlink"),
      path: pathSchema,
      mode: z.number().int().min(0).max(0o7777),
      target: z.string().min(1).max(4096),
    })
    .strict(),
]);
export type ExactSkillTree = readonly z.infer<typeof entrySchema>[];
export const exactSkillTreeSchema = z.array(entrySchema).max(512);

export function hashExactTree(tree: ExactSkillTree | undefined): string | undefined {
  return tree === undefined ? undefined : hashProjectSkillValue(tree);
}
export function hashProjectSkillValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortProjectSkillValue(value)))
    .digest("hex");
}

function sortProjectSkillValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortProjectSkillValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortProjectSkillValue(nested)]),
  );
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Ancestors cannot redirect an effect; the skill itself may be a link and is never followed. */
export async function guardSkillPath(root: string, path: string): Promise<string> {
  const target = resolve(root, path);
  const within = relative(resolve(root), target);
  if (!within || within.startsWith("../") || within === "..") throw new Error("Skill effect path escapes its root.");
  let current = resolve(root);
  for (const part of ["", ...relative(root, dirname(target)).split("/").filter(Boolean)]) {
    current = join(current, part);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("Skill effect has an unsafe parent.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  return target;
}

export async function captureExactSkillTree(root: string, path: string): Promise<ExactSkillTree | undefined> {
  const target = await guardSkillPath(root, path);
  if (!(await pathExists(target))) return undefined;
  const entries: z.infer<typeof entrySchema>[] = [];
  let bytes = 0;
  const visit = async (suffix: string): Promise<void> => {
    pathSchema.parse(suffix);
    const absolute = suffix ? await guardSkillPath(root, `${path}/${suffix}`) : target;
    const before = await lstat(absolute);
    const mode = before.mode & 0o7777;
    if (entries.length >= 512) throw new Error("Skill parking exceeds its entry limit.");
    if (before.isSymbolicLink())
      entries.push({ kind: "symlink", path: suffix, mode, target: await readlink(absolute) });
    else if (before.isDirectory()) {
      entries.push({ kind: "directory", path: suffix, mode });
      for (const name of (await readdir(absolute)).sort()) await visit(suffix ? `${suffix}/${name}` : name);
    } else if (before.isFile()) {
      bytes += before.size;
      if (before.size > 1024 * 1024 || bytes > 16 * 1024 * 1024)
        throw new Error("Skill parking exceeds its byte limit.");
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const held = await handle.stat();
        if (held.ino !== before.ino || held.dev !== before.dev) throw new Error("Skill file changed during capture.");
        entries.push({ kind: "file", path: suffix, mode, data: (await handle.readFile()).toString("base64") });
      } finally {
        await handle.close();
      }
    } else throw new Error("Skill parking cannot capture special files.");
    const after = await lstat(absolute);
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mode !== before.mode ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Skill changed during capture; refresh its preview.");
  };
  await visit("");
  return entries;
}

export async function materializeExactSkillTree(root: string, path: string, tree: ExactSkillTree): Promise<void> {
  const target = await guardSkillPath(root, path);
  if (await pathExists(target)) throw new Error("Skill location is occupied; no content was overwritten.");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await guardSkillPath(root, path);
  for (const raw of tree) {
    const entry = entrySchema.parse(raw);
    const destination = entry.path ? await guardSkillPath(root, `${path}/${entry.path}`) : target;
    if (entry.kind === "directory") await mkdir(destination, { mode: 0o700 });
    else if (entry.kind === "symlink") {
      await symlink(entry.target, destination);
      if (((await lstat(destination)).mode & 0o7777) !== entry.mode) await lchmod(destination, entry.mode);
    } else await writeFile(destination, Buffer.from(entry.data, "base64"), { flag: "wx", mode: entry.mode });
  }
  for (const entry of [...tree].reverse()) {
    if (entry.kind !== "symlink") await chmod(join(target, entry.path), entry.mode);
  }
  if (hashExactTree(await captureExactSkillTree(root, path)) !== hashExactTree(tree))
    throw new Error("Skill content did not verify after materialization.");
}

export async function removeExactSkillTree(root: string, path: string, expectedHash: string): Promise<void> {
  if (hashExactTree(await captureExactSkillTree(root, path)) !== expectedHash)
    throw new Error("Skill content changed; refresh before removing it.");
  await rm(await guardSkillPath(root, path), { recursive: true });
}

export async function writeProjectSkillJson(root: string, path: string, value: unknown): Promise<void> {
  const target = await guardSkillPath(root, path);
  if (await pathExists(target)) {
    const details = await lstat(target);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Skill state file is unsafe.");
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await guardSkillPath(root, path);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readProjectSkillJson(root: string, path: string): Promise<unknown | undefined> {
  const target = await guardSkillPath(root, path);
  if (!(await pathExists(target))) return undefined;
  const details = await lstat(target);
  if (!details.isFile() || details.isSymbolicLink() || details.size > 16 * 1024 * 1024)
    throw new Error("Skill state file is unsafe or exceeds its limit.");
  return JSON.parse(await readFile(target, "utf8")) as unknown;
}
