import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { RegistryGrant } from "./registry-ipc";
import { currentGrantRoot } from "./granted-hashing";

/** Only ENOENT beneath verified regular directories proves absence. A dangling link is present. */
export async function isGrantedTargetAbsent(grant: RegistryGrant, relativePath: string): Promise<boolean> {
  const parts = relativePath.split(/[\\/]/u);
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) return false;
  if (!(await currentGrantRoot(grant))) return false;
  let path = grant.root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    try {
      const details = await lstat(path);
      if (details.isSymbolicLink() || (index < parts.length - 1 && !details.isDirectory())) return false;
    } catch (error: unknown) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return false;
}
