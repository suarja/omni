import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { publicationPathSchema } from "../../domain/publications";
import type { InventoryFilesystemPort } from "../../ports/inventory";

export async function optionalText(filesystem: InventoryFilesystemPort, path: string): Promise<string | undefined> {
  try {
    return await filesystem.readText(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "not-found") return undefined;
    throw error;
  }
}

export async function readPluginHashes(root: string, folder: string): Promise<Record<string, string>> {
  publicationPathSchema.parse(folder);
  const filesystem = createLocalInventoryPort(root, { maxFileBytes: 32 * 1024 * 1024, maxEntries: 10000 });
  const hashes: Record<string, string> = Object.create(null);
  let entries = 0;
  let byteLength = 0;
  const visit = async (path: string, relative: string): Promise<void> => {
    for (const node of await filesystem.listDirectory(path)) {
      if (++entries > 10000) throw new Error("The plugin exceeds the publication entry limit.");
      const child = relative ? `${relative}/${node.name}` : node.name;
      publicationPathSchema.parse(child);
      if (child === "omni.plugin.json") continue;
      const target = `${folder}/${child}`;
      if (node.type === "directory") await visit(target, child);
      else if (node.type === "file") {
        byteLength += (await filesystem.lstat(target)).size;
        if (byteLength > 64 * 1024 * 1024) throw new Error("The plugin exceeds the publication byte limit.");
        hashes[child] = await filesystem.hash(target);
      } else throw new Error("Publication files must be regular files and directories.");
    }
  };
  try {
    await filesystem.lstat(folder);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "not-found") return hashes;
    throw error;
  }
  await visit(folder, "");
  return hashes;
}
