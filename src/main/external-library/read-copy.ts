import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExternalSourceRecord } from "../../domain/external-sources";
import { cloneExternalReadCopy, refreshExternalReadCopy, classifyGitFailure } from "../git-command";
import { readGitText } from "../git-read";
import { isMissing } from "../fs-optional";
import type { ExternalSourcesStore } from "./store";

export type ExternalReadCopyOptions = Readonly<{
  userDataPath: string;
  resolveUrl?: (repo: string) => string;
  now?: () => number;
}>;
export function externalReadCopyPath(options: ExternalReadCopyOptions, source: ExternalSourceRecord): string {
  return join(resolve(options.userDataPath), "omni/external-sources", source.readCopyFolder);
}
async function assertOwnedDirectory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
    throw new Error("The external read-copy folder is unsafe. Restore its Omni directory and check again.");
}
export async function checkExternalReadCopy(
  options: ExternalReadCopyOptions,
  store: ExternalSourcesStore,
  source: ExternalSourceRecord,
): Promise<void> {
  const folder = externalReadCopyPath(options, source);
  const parent = join(resolve(options.userDataPath), "omni/external-sources");
  const url = options.resolveUrl?.(source.repo) ?? `https://github.com/${source.repo}.git`;
  const lastCheckAt = new Date((options.now ?? Date.now)()).toISOString();
  try {
    await mkdir(parent, { recursive: true });
    await assertOwnedDirectory(parent);
    let present = true;
    try {
      await lstat(folder);
    } catch (error) {
      if (!isMissing(error)) throw error;
      present = false;
    }
    if (present) {
      await assertOwnedDirectory(folder);
      await refreshExternalReadCopy(folder, url);
    } else {
      const temporary = join(parent, `.clone-${randomUUID()}`);
      try {
        await cloneExternalReadCopy(parent, url, temporary);
        await rename(temporary, folder);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    const commit = await readGitText(folder, ["rev-parse", "HEAD"]),
      date = await readGitText(folder, ["log", "-1", "--format=%cI"]);
    if (!commit || !date) throw new Error("The external source HEAD could not be read. Check the source again.");
    await store.upsert({
      ...source,
      lastCheckAt,
      head: { commit, date: new Date(date).toISOString() },
      lastError: undefined,
    });
  } catch (error) {
    await store.upsert({ ...source, lastCheckAt, lastError: classifyGitFailure(error) });
  }
}
