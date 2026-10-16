import { createHash } from "node:crypto";

import type { SkillObservationFilesystem, SkillObservationGrant } from "../../ports/skill-reconciliation";
import type { SkillDirectoryEnvelope } from "../../shared/skill-directory-envelope";

const MAX_ENTRIES = 2048;
const MAX_FILES = 512;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;

type Entry = Readonly<{ path: string; kind: "file" | "directory"; identity: string }>;

function safeName(name: string): boolean {
  return Boolean(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

function stableIdentity(identity: string): string {
  return identity.split(":").slice(0, 2).join(":");
}

function isGitPath(path: string): boolean {
  return path.split("/").some((part) => part === ".git");
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

export async function readSkillDetachmentEnvelope(
  grant: SkillObservationGrant,
  folderPath: string,
  filesystem: SkillObservationFilesystem,
): Promise<SkillDirectoryEnvelope | undefined> {
  const entries: Entry[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  const listNames = async (relativePath: string): Promise<readonly string[]> => {
    const names = [...(await filesystem.listDirectory(grant, relativePath))].sort((left, right) =>
      left.localeCompare(right),
    );
    if (names.some((name) => !safeName(name)) || new Set(names).size !== names.length)
      throw new Error("The selected folder contains an unsafe or ambiguous path.");
    return names;
  };

  const visit = async (relativePath: string, logicalPath: string): Promise<void> => {
    const node = await filesystem.lstat(grant, relativePath);
    if (node.kind !== "directory" && node.kind !== "file")
      throw new Error("The selected folder contains an unsafe entry.");
    if (entries.length >= MAX_ENTRIES) throw new Error("The selected folder exceeds the entry limit.");
    const identity = stableIdentity(node.identity);
    let contentHash: string | undefined;
    if (node.kind === "file") {
      fileCount += 1;
      totalBytes += node.byteLength;
      if (
        !Number.isSafeInteger(node.byteLength) ||
        node.byteLength < 0 ||
        fileCount > MAX_FILES ||
        node.byteLength > MAX_FILE_BYTES ||
        totalBytes > MAX_TREE_BYTES
      ) {
        throw new Error("The selected folder exceeds the file read limits.");
      }
      if (isGitPath(logicalPath)) {
        const file = await filesystem.readFile(grant, relativePath, node.identity, MAX_FILE_BYTES);
        if (file.identity !== node.identity || file.bytes.byteLength !== node.byteLength)
          throw new Error("The selected repository metadata changed during the read.");
        contentHash = createHash("sha256").update(file.bytes).digest("hex");
      }
    }
    entries.push({
      path: logicalPath,
      kind: node.kind,
      identity: contentHash ? `${identity}:${contentHash}` : identity,
    });

    if (node.kind === "directory") {
      const namesBefore = await listNames(relativePath);
      for (const name of namesBefore) {
        const childPath = `${relativePath}/${name}`;
        const childLogicalPath = logicalPath === "." ? name : `${logicalPath}/${name}`;
        await visit(childPath, childLogicalPath);
      }
      const namesAfter = await listNames(relativePath);
      const after = await filesystem.lstat(grant, relativePath);
      if (after.kind !== "directory" || after.identity !== node.identity || !sameNames(namesBefore, namesAfter))
        throw new Error("The selected folder changed during the read.");
    } else {
      const after = await filesystem.lstat(grant, relativePath);
      if (after.kind !== "file" || after.identity !== node.identity)
        throw new Error("The selected folder changed during the read.");
    }
  };

  try {
    await visit(folderPath, ".");
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  } catch {
    return undefined;
  }
}
