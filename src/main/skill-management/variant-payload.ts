import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parsePackageManifest } from "../../domain/marketplace-format";

const HASH = /^[a-f0-9]{64}$/u;
const PAYLOAD_VERSION = 1;

type PayloadFile = Readonly<{ relativePath: string; hash: string; byteLength: number; storedAs: string }>;
type PayloadIndex = Readonly<{
  version: 1;
  intentId: string;
  files: readonly PayloadFile[];
  directories: readonly string[];
  manifest: Readonly<{ relativePath: string; beforeHash: string; afterHash: string }>;
}>;

export type PreparedVariantPayload = Readonly<{
  root: string;
  index: PayloadIndex;
  files: ReadonlyMap<string, Uint8Array>;
  manifestBefore: Uint8Array;
  manifestAfter: Uint8Array;
}>;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(path: string): boolean {
  return (
    Boolean(path) &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function payloadRoot(userDataPath: string, intentId: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(intentId)) throw new Error("Capture intent id is invalid.");
  return join(userDataPath, "omni", "skill-variant-captures", intentId);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory())
    throw new Error("Variant recovery directory must be a regular directory.");
  await chmod(path, 0o700);
}

async function writeExclusiveOrVerify(path: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o600);
  } catch (error: unknown) {
    if (!isCode(error, "EEXIST")) throw error;
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile())
      throw new Error("Variant recovery file must be regular and immutable.");
    const existing = await readFile(path);
    if (hash(existing) !== hash(bytes) || existing.byteLength !== bytes.byteLength)
      throw new Error("Variant recovery file already contains different bytes.");
  } finally {
    await handle?.close();
  }
}

export async function prepareVariantPayload(
  args: Readonly<{
    userDataPath: string;
    intentId: string;
    files: ReadonlyMap<string, Uint8Array>;
    directories: readonly string[];
    manifestPath: string;
    manifestBefore: Uint8Array;
    manifestAfter: Uint8Array;
  }>,
): Promise<PreparedVariantPayload> {
  const root = payloadRoot(args.userDataPath, args.intentId);
  await ensurePrivateDirectory(join(args.userDataPath, "omni"));
  await ensurePrivateDirectory(dirname(root));
  await ensurePrivateDirectory(root);
  const payloadDirectory = join(root, "files");
  await ensurePrivateDirectory(payloadDirectory);
  const files = [...args.files.entries()].sort(([left], [right]) => left.localeCompare(right));
  const entries: PayloadFile[] = [];
  for (const [index, [relativePath, bytes]] of files.entries()) {
    if (!safeRelative(relativePath) || bytes.byteLength > 1024 * 1024)
      throw new Error("Variant payload file exceeds safe limits.");
    const storedAs = `${index.toString().padStart(4, "0")}.bin`;
    await writeExclusiveOrVerify(join(payloadDirectory, storedAs), bytes);
    entries.push({ relativePath, hash: hash(bytes), byteLength: bytes.byteLength, storedAs });
  }
  const manifestBeforeHash = hash(args.manifestBefore);
  const manifestAfterHash = hash(args.manifestAfter);
  if (args.manifestBefore.byteLength > 1024 * 1024 || args.manifestAfter.byteLength > 1024 * 1024)
    throw new Error("Variant plugin manifest exceeds the safe payload limit.");
  await writeExclusiveOrVerify(join(root, "manifest-before.bin"), args.manifestBefore);
  await writeExclusiveOrVerify(join(root, "manifest-after.bin"), args.manifestAfter);
  const directoryList = [...new Set(args.directories)].sort((left, right) => left.localeCompare(right));
  if (directoryList.some((path) => !safeRelative(path))) throw new Error("Variant payload directory path is unsafe.");
  const index: PayloadIndex = {
    version: PAYLOAD_VERSION,
    intentId: args.intentId,
    files: entries,
    directories: directoryList,
    manifest: { relativePath: args.manifestPath, beforeHash: manifestBeforeHash, afterHash: manifestAfterHash },
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
  await writeExclusiveOrVerify(join(root, "index.json"), indexBytes);
  const prepared = await readPreparedVariantPayload(args.userDataPath, args.intentId);
  if (!prepared) throw new Error("Prepared variant recovery payload failed verification.");
  return prepared;
}

function parsePayloadIndex(value: unknown, intentId: string): PayloadIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Variant payload index is invalid.");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["version", "intentId", "files", "directories", "manifest"].includes(key)) ||
    input.version !== 1 ||
    input.intentId !== intentId ||
    !Array.isArray(input.files) ||
    !Array.isArray(input.directories) ||
    input.files.length > 512
  )
    throw new Error("Variant payload index is invalid.");
  const files = input.files.map((raw): PayloadFile => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error("Variant payload file entry is invalid.");
    const file = raw as Record<string, unknown>;
    if (
      Object.keys(file).some((key) => !["relativePath", "hash", "byteLength", "storedAs"].includes(key)) ||
      typeof file.relativePath !== "string" ||
      !safeRelative(file.relativePath) ||
      typeof file.hash !== "string" ||
      !HASH.test(file.hash) ||
      typeof file.byteLength !== "number" ||
      !Number.isSafeInteger(file.byteLength) ||
      file.byteLength < 0 ||
      file.byteLength > 1024 * 1024 ||
      typeof file.storedAs !== "string" ||
      !/^\d{4}\.bin$/u.test(file.storedAs)
    )
      throw new Error("Variant payload file entry is invalid.");
    return { relativePath: file.relativePath, hash: file.hash, byteLength: file.byteLength, storedAs: file.storedAs };
  });
  const manifest = input.manifest;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
    throw new Error("Variant payload manifest is invalid.");
  const manifestValue = manifest as Record<string, unknown>;
  if (
    Object.keys(manifestValue).some((key) => !["relativePath", "beforeHash", "afterHash"].includes(key)) ||
    typeof manifestValue.relativePath !== "string" ||
    !safeRelative(manifestValue.relativePath) ||
    typeof manifestValue.beforeHash !== "string" ||
    !HASH.test(manifestValue.beforeHash) ||
    typeof manifestValue.afterHash !== "string" ||
    !HASH.test(manifestValue.afterHash)
  )
    throw new Error("Variant payload manifest is invalid.");
  const directories = input.directories.map((path) => {
    if (typeof path !== "string" || !safeRelative(path)) throw new Error("Variant payload directory is invalid.");
    return path;
  });
  if (
    files.reduce((total, file) => total + file.byteLength, 0) > 16 * 1024 * 1024 ||
    new Set(files.map(({ storedAs }) => storedAs)).size !== files.length ||
    new Set(files.map(({ relativePath }) => relativePath)).size !== files.length ||
    new Set(directories).size !== directories.length
  )
    throw new Error("Variant payload entries are duplicated.");
  return { version: 1, intentId, files, directories, manifest: manifestValue as PayloadIndex["manifest"] };
}

export async function readPreparedVariantPayload(
  userDataPath: string,
  intentId: string,
): Promise<PreparedVariantPayload | undefined> {
  const root = payloadRoot(userDataPath, intentId);
  try {
    const rootDetails = await lstat(root);
    if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) return undefined;
    const indexDetails = await lstat(join(root, "index.json"));
    if (indexDetails.isSymbolicLink() || !indexDetails.isFile() || indexDetails.size > 256 * 1024) return undefined;
    const index = parsePayloadIndex(JSON.parse(await readFile(join(root, "index.json"), "utf8")) as unknown, intentId);
    for (const directory of [join(userDataPath, "omni"), dirname(root), join(root, "files")]) {
      const details = await lstat(directory);
      if (details.isSymbolicLink() || !details.isDirectory()) return undefined;
    }
    for (const name of ["manifest-before.bin", "manifest-after.bin"]) {
      const details = await lstat(join(root, name));
      if (details.isSymbolicLink() || !details.isFile() || details.size > 1024 * 1024) return undefined;
    }
    const files = new Map<string, Uint8Array>();
    for (const entry of index.files) {
      const path = join(root, "files", entry.storedAs);
      const details = await lstat(path);
      if (details.isSymbolicLink() || !details.isFile() || details.size !== entry.byteLength) return undefined;
      const bytes = Uint8Array.from(await readFile(path));
      if (hash(bytes) !== entry.hash) return undefined;
      files.set(entry.relativePath, bytes);
    }
    const manifestBefore = Uint8Array.from(await readFile(join(root, "manifest-before.bin")));
    const manifestAfter = Uint8Array.from(await readFile(join(root, "manifest-after.bin")));
    if (hash(manifestBefore) !== index.manifest.beforeHash || hash(manifestAfter) !== index.manifest.afterHash)
      return undefined;
    return { root, index, files, manifestBefore, manifestAfter };
  } catch {
    return undefined;
  }
}

export function variantPayloadFolder(payload: PreparedVariantPayload): string {
  const before = parsePackageManifest(JSON.parse(Buffer.from(payload.manifestBefore).toString("utf8")) as unknown);
  const after = parsePackageManifest(JSON.parse(Buffer.from(payload.manifestAfter).toString("utf8")) as unknown);
  const added = after.artifacts.filter(
    (item) =>
      item.kind === "skill" &&
      item.variantOrigin &&
      !before.artifacts.some((previous) => previous.kind === item.kind && previous.path === item.path),
  );
  const manifestPath = payload.index.manifest.relativePath;
  if (added.length !== 1 || !(manifestPath === "omni.plugin.json" || manifestPath.endsWith("/omni.plugin.json")))
    throw new Error("The saved capture does not identify one new skill in its exact plugin manifest.");
  const prefix = manifestPath === "omni.plugin.json" ? "" : manifestPath.slice(0, -"/omni.plugin.json".length);
  const folder = prefix ? `${prefix}/${added[0]!.path}` : added[0]!.path;
  if (
    !safeRelative(folder) ||
    !payload.index.directories.includes(folder) ||
    !payload.index.files.length ||
    payload.index.files.some((file) => !file.relativePath.startsWith(`${folder}/`)) ||
    payload.index.directories.some(
      (path) => path !== folder.split("/").slice(0, -1).join("/") && path !== folder && !path.startsWith(`${folder}/`),
    )
  )
    throw new Error("The saved capture tree escapes its reviewed skill folder.");
  return folder;
}
