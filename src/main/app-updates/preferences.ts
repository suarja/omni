import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface UpdatePreferences {
  read(): Promise<boolean>;
  write(enabled: boolean): Promise<void>;
}
export function createUpdatePreferences(path: string): UpdatePreferences {
  let queue = Promise.resolve();
  async function read(): Promise<boolean> {
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 2 || record.schemaVersion !== 1 || typeof record.enabled !== "boolean")
        throw new Error();
      return record.enabled;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw new Error("App update preferences are invalid. Restore the preferences file before changing updates.");
    }
  }
  function write(enabled: boolean): Promise<void> {
    const result = queue.then(async () => {
      if (typeof enabled !== "boolean") throw new Error("App update preference must be a boolean.");
      await read();
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schemaVersion: 1, enabled }) + "\n", { mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    queue = result.catch(() => undefined);
    return result;
  }
  return { read, write };
}
