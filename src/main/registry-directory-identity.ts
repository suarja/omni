import { realpath, stat } from "node:fs/promises";
export type DirectoryIdentity = Readonly<{
  canonicalPath: string;
  device: string;
  inode: string;
}>;

function identityPart(value: bigint | number): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

export async function readDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const canonicalPath = await realpath(path);
  const details = await stat(canonicalPath);
  if (!details.isDirectory()) throw new Error("Registered root is not a directory.");
  return {
    canonicalPath,
    device: identityPart(details.dev),
    inode: identityPart(details.ino),
  };
}
