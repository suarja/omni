import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  externalSourcesStoreSchema,
  type ExternalSourceRecord,
  type ExternalSourcesRecord,
  type ExternalCopyVersion,
} from "../../domain/external-sources";
import { isMissing } from "../fs-optional";
export interface ExternalSourcesStore {
  read(): Promise<ExternalSourcesRecord>;
  upsert(source: ExternalSourceRecord): Promise<void>;
  cacheCopyVersion(version: ExternalCopyVersion): Promise<void>;
}
const queues = new Map<string, Promise<void>>();
async function assertRegular(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isFile())
      throw new Error("External sources store must be a regular file. Restore it before checking again.");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
export function createExternalSourcesStore(filePath: string): ExternalSourcesStore {
  const path = resolve(filePath);
  const read = async (): Promise<ExternalSourcesRecord> => {
    await assertRegular(path);
    try {
      return externalSourcesStoreSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, sources: [] };
      throw error;
    }
  };
  const update = (change: (current: ExternalSourcesRecord) => ExternalSourcesRecord): Promise<void> => {
    const result = (queues.get(path) ?? Promise.resolve()).then(async () => {
      const current = await read();
      const next = externalSourcesStoreSchema.parse(JSON.parse(JSON.stringify(change(current))));
      await mkdir(dirname(path), { recursive: true });
      const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await assertRegular(path);
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    });
    queues.set(
      path,
      result.catch(() => undefined),
    );
    return result;
  };
  return {
    read,
    upsert: (source) =>
      update((current) => ({
        ...current,
        sources: [...current.sources.filter((entry) => entry.repo !== source.repo), source].sort((a, b) =>
          a.repo.localeCompare(b.repo),
        ),
      })),
    cacheCopyVersion: (version) =>
      update((current) => ({
        ...current,
        copyVersions: [
          ...(current.copyVersions ?? []).filter(
            (entry) =>
              entry.repo !== version.repo ||
              entry.skillPath !== version.skillPath ||
              entry.copyHash !== version.copyHash,
          ),
          version,
        ],
      })),
  };
}
