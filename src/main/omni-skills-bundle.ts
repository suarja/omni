import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveResource, type ResourceOptions } from "./omni-resources";
import { isMissing } from "./fs-optional";

const BUNDLE_RELATIVE_PATH = join("packages", "omni-skills", "skills");
const MAX_FILES = 64;
const MAX_BYTES = 512 * 1024;

export type OmniSkillBundleFile = Readonly<{ relativePath: string; content: string }>;
export type OmniSkillBundleItem = Readonly<{ name: string; files: readonly OmniSkillBundleFile[] }>;
export type OmniSkillBundle = readonly OmniSkillBundleItem[];

export function bundleRoot(options: ResourceOptions = {}): string {
  return resolveResource(BUNDLE_RELATIVE_PATH, options);
}

type BundleLimits = { files: number; bytes: number };

async function readFiles(
  root: string,
  relativePath = "",
  limits: BundleLimits = { files: 0, bytes: 0 },
): Promise<OmniSkillBundleFile[]> {
  const directory = join(root, relativePath);
  const result: OmniSkillBundleFile[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = relativePath ? join(relativePath, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Omni skills bundle contains a symlink: ${child}`);
    if (entry.isDirectory()) result.push(...(await readFiles(root, child, limits)));
    else if (entry.isFile()) {
      const details = await lstat(join(root, child));
      if (limits.files >= MAX_FILES || limits.bytes + details.size > MAX_BYTES)
        throw new Error("Omni skill exceeds the bundle limit.");
      const bytes = await readFile(join(root, child));
      const content = bytes.toString("utf8");
      if (content.includes("\u0000") || Buffer.from(content, "utf8").compare(bytes) !== 0)
        throw new Error(`Omni skills bundle contains a non-text file: ${child}`);
      result.push({ relativePath: child.replaceAll("\\", "/"), content });
      limits.files += 1;
      limits.bytes += bytes.byteLength;
    } else throw new Error(`Omni skills bundle contains an unsupported entry: ${child}`);
  }
  return result;
}

export async function readBundle(root: string): Promise<OmniSkillBundle> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) throw new Error("Omni skills bundle is unavailable.");
    throw error;
  }
  const bundle: OmniSkillBundleItem[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new Error(`Invalid Omni skills bundle entry: ${entry.name}`);
    const files = await readFiles(join(root, entry.name));
    bundle.push({
      name: entry.name,
      files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    });
  }
  return bundle;
}

export function bundleHash(bundle: OmniSkillBundle): string {
  const hash = createHash("sha256");
  const files = bundle.flatMap((skill) =>
    skill.files.map((file) => ({ path: `${skill.name}/${file.relativePath}`, content: file.content })),
  );
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path)))
    hash.update(`${file.path}\n${file.content}`);
  return hash.digest("hex");
}
