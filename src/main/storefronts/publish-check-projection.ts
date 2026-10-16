import type { PublicationCheckFile } from "../../domain/publish-checks";
import type { FileTree } from "./publish-context";
export function projectPublicationChecks(tree: FileTree, prefix: string): readonly PublicationCheckFile[] {
  return Object.entries(tree).map(([path, bytes]) => {
    const content = Buffer.from(bytes).toString("utf8");
    const binary = bytes.includes(0) || !Buffer.from(content, "utf8").equals(Buffer.from(bytes));
    // Retain readable sensitive literals for privacy checks; skill validity sees only binary presence.
    return { path: `${prefix}/${path}`, content, ...(binary ? { binary: true } : {}) };
  });
}
