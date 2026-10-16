import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { RegistryGrant } from "../registry-ipc";
import { currentGrantRoot } from "../granted-hashing";

export async function assertResolutionWritePath(grant: RegistryGrant, relativePath: string): Promise<void> {
  if (!(await currentGrantRoot(grant)))
    throw new Error("The selected project root changed before the managed resolution file effect.");
  let current = grant.root;
  for (const part of relativePath.split("/").slice(0, -1)) {
    current = join(current, part);
    const details = await lstat(current).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!details) return;
    if (details.isSymbolicLink() || !details.isDirectory())
      throw new Error(`Managed resolution path has a linked or non-directory ancestor: ${relativePath}`);
  }
}
