import { basename } from "node:path";
import { parseSkillsLock } from "../domain/skill-origins/skills-lock";
import type { SkillCopyProvenance } from "../shared/skill-copy-provenance";
import { readRegularFile } from "./operation-files";

export async function readImportedSkillOrigin(root: string, folder: string): Promise<SkillCopyProvenance | undefined> {
  const bytes = await readRegularFile(root, "skills-lock.json");
  if (!bytes) return undefined;
  const lock = parseSkillsLock(JSON.parse(Buffer.from(bytes).toString("utf8")));
  const key = basename(folder);
  const entry = lock.entries.find((entry) => entry.skillKey === key);
  if (!entry) return undefined;
  return {
    source: entry.source.locator,
    ...(entry.reference ? { ref: entry.reference } : {}),
    ...(entry.sourceSkillPath ? { skillPath: entry.sourceSkillPath } : {}),
    computedHash: entry.recordedHash,
  };
}
