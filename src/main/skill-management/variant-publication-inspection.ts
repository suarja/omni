import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";

import { currentGrantRoot } from "../granted-hashing";
import { resolveVariantPath } from "./variant-file-effects";
import { variantPayloadFolder } from "./variant-payload";
import type { RegistryGrant } from "../registry-ipc";
import type { PreparedVariantPayload } from "./variant-publication";

export type VariantPublicationInspection = Readonly<{
  manifestState: "before" | "after";
  manifestBytes: Uint8Array;
  presentFiles: readonly string[];
  fileIdentities: Readonly<Record<string, string>>;
  presentDirectories: readonly Readonly<{ relativePath: string; identity: string }>[];
}>;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function assertParentDirectories(grant: RegistryGrant, relativePath: string): Promise<void> {
  const segments = relativePath.split("/").slice(0, -1);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const details = await lstat(await resolveVariantPath(grant, current));
    if (details.isSymbolicLink() || !details.isDirectory())
      throw new Error("A captured destination ancestor is not a regular directory.");
  }
}

async function regularBytes(grant: RegistryGrant, relativePath: string): Promise<Uint8Array> {
  await assertParentDirectories(grant, relativePath);
  const target = await resolveVariantPath(grant, relativePath);
  const before = await lstat(target, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("A captured destination file is not regular.");
  const bytes = Uint8Array.from(await readFile(target));
  const after = await lstat(target, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  )
    throw new Error("A captured destination file changed during inspection.");
  return bytes;
}

export async function inspectVariantPublication(
  args: Readonly<{
    grant: RegistryGrant;
    payload: PreparedVariantPayload;
  }>,
): Promise<VariantPublicationInspection> {
  const { grant, payload } = args;
  if (!(await currentGrantRoot(grant))) throw new Error("The selected source root changed before recovery inspection.");
  const folderPath = variantPayloadFolder(payload);
  if (!folderPath) throw new Error("The saved capture has no skill files.");
  const expectedFiles = new Set(payload.index.files.map(({ relativePath }) => relativePath));
  const expectedDirectories = new Set(payload.index.directories);
  const presentFiles: string[] = [];
  const fileIdentities: Record<string, string> = {};
  const presentDirectories = new Map<string, string>();
  const visit = async (relativePath: string): Promise<void> => {
    const target = await resolveVariantPath(grant, relativePath);
    const details = await lstat(target, { bigint: true });
    if (details.isSymbolicLink()) throw new Error("The captured destination contains a linked entry.");
    if (details.isDirectory()) {
      if (!expectedDirectories.has(relativePath))
        throw new Error("The captured destination contains an unexpected directory.");
      presentDirectories.set(relativePath, `${details.dev}:${details.ino}`);
      const children = [...(await readdir(target))].sort((left, right) => left.localeCompare(right));
      for (const child of children) await visit(`${relativePath}/${child}`);
      return;
    }
    if (!details.isFile() || !expectedFiles.has(relativePath))
      throw new Error("The captured destination contains an unexpected entry.");
    const entry = payload.index.files.find(({ relativePath: candidate }) => candidate === relativePath)!;
    const bytes = await regularBytes(grant, relativePath);
    if (bytes.byteLength !== entry.byteLength || hash(bytes) !== entry.hash)
      throw new Error("A captured destination file differs from its saved bytes.");
    fileIdentities[relativePath] = `${details.dev}:${details.ino}`;
    presentFiles.push(relativePath);
  };
  const targetRoot = await resolveVariantPath(grant, folderPath);
  try {
    const details = await lstat(targetRoot, { bigint: true });
    if (details.isSymbolicLink() || !details.isDirectory())
      throw new Error("The captured skill destination is not a regular directory.");
    await visit(folderPath);
  } catch (error: unknown) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  for (const path of payload.index.directories) {
    try {
      const details = await lstat(await resolveVariantPath(grant, path), { bigint: true });
      if (details.isSymbolicLink() || !details.isDirectory())
        throw new Error("A reviewed capture directory changed type.");
      if (!presentDirectories.has(path)) presentDirectories.set(path, `${details.dev}:${details.ino}`);
    } catch (error: unknown) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
  const manifestBytes = await regularBytes(grant, payload.index.manifest.relativePath);
  const manifestHash = hash(manifestBytes);
  const manifestState =
    manifestHash === payload.index.manifest.beforeHash
      ? "before"
      : manifestHash === payload.index.manifest.afterHash
        ? "after"
        : undefined;
  if (!manifestState) throw new Error("The plugin manifest differs from both saved capture states.");
  if (!(await currentGrantRoot(grant))) throw new Error("The selected source root changed during recovery inspection.");
  return {
    manifestState,
    manifestBytes,
    fileIdentities,
    presentFiles: presentFiles.sort((left, right) => left.localeCompare(right)),
    presentDirectories: [...presentDirectories]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, identity]) => ({ relativePath, identity })),
  };
}
