import { createHash } from "node:crypto";
import { classifyPublicationDrift } from "../../domain/publication-drift";
import type { ExternalUse, ExternalComparison } from "../../shared/external-library-ipc";
import type { ExternalLockedUse } from "./detection";
import { fingerprintExternalFiles, readExternalTree } from "./trees";
import { readProjectExternalTree } from "./use-reader";

type Files = Record<string, Uint8Array>;
function hashes(files: Files): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")]),
  );
}
function version(bytes?: Uint8Array): ExternalComparison["files"][number]["base"] {
  if (!bytes) return undefined;
  let text: string | undefined;
  try {
    if (!bytes.includes(0)) text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    /* Binary files remain comparable by hash. */
  }
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    binary: text === undefined,
    ...(text === undefined ? {} : { text }),
  };
}
export async function readExternalComparison(
  use: ExternalUse,
  locked: ExternalLockedUse,
  sourceRoot: string,
  recoveredFiles?: Files,
): Promise<ExternalComparison> {
  const unavailable: ExternalComparison = {
    status: "unavailable",
    useId: use.id,
    base: use.base,
    files: [],
    diagnostic: "A verified install base, copy and source are required for per-file comparison.",
  };
  if (use.base.status !== "found" || !use.skillPath || !use.folderPath || use.state === "unknown") return unavailable;
  try {
    const rawBase = recoveredFiles;
    const base =
      rawBase &&
      Object.fromEntries(
        Object.entries(rawBase).filter(
          ([path]) => !path.split("/").some((part) => part === ".git" || part === "node_modules"),
        ),
      );
    const copy = await readProjectExternalTree(locked.root, use.folderPath),
      source = await readExternalTree(sourceRoot, use.skillPath);
    if (
      !base ||
      !copy ||
      !source ||
      fingerprintExternalFiles(base) !== (use.lockStale ? use.copyHash : use.lockHash) ||
      copy.hash !== use.copyHash ||
      source.hash !== use.sourceHash
    )
      return unavailable;
    const drift = classifyPublicationDrift(hashes(base), hashes(source.files), hashes(copy.files));
    return {
      status: "ready",
      useId: use.id,
      base: use.base,
      files: drift.files.map((file) => ({
        ...file,
        ...(base[file.path] ? { base: version(base[file.path]) } : {}),
        ...(copy.files[file.path] ? { copy: version(copy.files[file.path]) } : {}),
        ...(source.files[file.path] ? { source: version(source.files[file.path]) } : {}),
      })),
    };
  } catch {
    return unavailable;
  }
}
