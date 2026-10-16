import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parsePublicationsState, type Publication, type PublicationsState } from "../../domain/publications";

type Result =
  | Readonly<{ status: "ready"; publications: readonly Publication[] }>
  | Readonly<{ status: "corrupt"; diagnostic: string; recoveryAvailable: boolean }>;
export interface PublicationsStore {
  read(): Promise<Result>;
  assertFresh(): Promise<void>;
  remove(storefrontSourceId: string, pluginId: string): Promise<Result>;
  save(publications: readonly Publication[]): Promise<Result>;
}
const stores = new Map<string, PublicationsStore>();
function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function regularText(path: string): Promise<string | undefined> {
  try {
    const node = await lstat(path);
    if (!node.isFile() || node.isSymbolicLink()) throw new Error("Publications store must be a regular file.");
    return await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function validBackup(path: string): Promise<boolean> {
  try {
    const text = await regularText(`${path}.bak`);
    return text !== undefined && Boolean(parsePublicationsState(JSON.parse(text)));
  } catch {
    return false;
  }
}
async function writeAtomically(path: string, content: string): Promise<void> {
  await regularText(path);
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
export function publicationsFilePath(userDataPath: string): string {
  return join(userDataPath, "omni/publications.json");
}

export function createPublicationsStore(filePath: string): PublicationsStore {
  const path = resolve(filePath);
  const existing = stores.get(path);
  if (existing) return existing;
  let loaded: Result | undefined;
  let diskText: string | undefined;
  let loading: Promise<Result> | undefined;
  let tail = Promise.resolve();
  const load = async (): Promise<Result> => {
    try {
      diskText = await regularText(path);
      const backup = await regularText(`${path}.bak`);
      if (diskText === undefined && backup !== undefined)
        throw new Error("Publications file is missing; inspect its backup.");
      const state = diskText === undefined ? { publications: [] } : parsePublicationsState(JSON.parse(diskText));
      return { status: "ready", publications: state.publications };
    } catch {
      return {
        status: "corrupt",
        diagnostic: "Publications store could not be read safely. Inspect the store and its backup.",
        recoveryAvailable: await validBackup(path),
      };
    }
  };
  const read = async (): Promise<Result> => {
    loaded ??= await (loading ??= load());
    return loaded;
  };
  const save = async (incoming: readonly Publication[]): Promise<Result> => {
    const validated = parsePublicationsState({ schemaVersion: 1, publications: incoming }).publications;
    const operation = tail.then(async (): Promise<Result> => {
      const current = await read();
      if (current.status !== "ready") return current;
      if ((await regularText(path)) !== diskText)
        throw new Error("Publications store changed locally. Reload before saving publications.");
      const keys = new Set(validated.map((record) => `${record.storefrontSourceId}/${record.pluginId}`));
      const next: PublicationsState = parsePublicationsState({
        schemaVersion: 1,
        publications: [
          ...current.publications.filter((record) => !keys.has(`${record.storefrontSourceId}/${record.pluginId}`)),
          ...validated,
        ],
      });
      const content = `${JSON.stringify(next, null, 2)}\n`;
      await writeAtomically(`${path}.bak`, content);
      await writeAtomically(path, content);
      diskText = content;
      loaded = { status: "ready", publications: next.publications };
      return loaded;
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  const remove = async (storefrontSourceId: string, pluginId: string): Promise<Result> => {
    const operation = tail.then(async (): Promise<Result> => {
      const current = await read();
      if (current.status !== "ready") return current;
      if ((await regularText(path)) !== diskText)
        throw new Error("Publications store changed locally. Reload before restoring publications.");
      const next = parsePublicationsState({
        schemaVersion: 1,
        publications: current.publications.filter(
          (record) => record.storefrontSourceId !== storefrontSourceId || record.pluginId !== pluginId,
        ),
      });
      const content = `${JSON.stringify(next, null, 2)}\n`;
      await writeAtomically(`${path}.bak`, content);
      await writeAtomically(path, content);
      diskText = content;
      loaded = { status: "ready", publications: next.publications };
      return loaded;
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  const assertFresh = async (): Promise<void> => {
    const current = await read();
    if (current.status !== "ready") throw new Error(current.diagnostic);
    if ((await regularText(path)) !== diskText)
      throw new Error("Publications store changed locally. Reload before publishing.");
  };
  const store = { read, save, remove, assertFresh };
  stores.set(path, store);
  return store;
}
