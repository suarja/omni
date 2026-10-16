import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";

import type { ActivityEvidenceIo } from "../adapters/activity";
import {
  getSharedIsolatedDirectoryReader,
  isOptionalDirectoryError,
  type IsolatedDirectoryReader,
} from "./isolated-directory-reader";

async function readBounded(path: string, options: { head?: number; tail?: number }): Promise<string | null> {
  const limit = options.head ?? options.tail;
  if (!limit || limit < 1) return null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const details = await handle.stat();
    const length = Math.min(limit, details.size);
    const position = options.tail ? Math.max(0, details.size - length) : 0;
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function createActivityEvidenceIo(
  homeDir = homedir(),
  directoryReader: IsolatedDirectoryReader = getSharedIsolatedDirectoryReader(),
): ActivityEvidenceIo {
  return {
    homeDir,
    now: Date.now,
    readText: readBounded,
    readDir: async (path) =>
      directoryReader.readDirectory(path).then(
        (entries) => entries.map((entry) => entry.name),
        (error: unknown) => {
          if (isOptionalDirectoryError(error)) return [];
          throw error;
        },
      ),
    stat: async (path) =>
      stat(path)
        .then((details) => ({ mtimeMs: details.mtimeMs }))
        .catch(() => null),
  };
}
