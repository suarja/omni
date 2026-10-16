import { resolve } from "node:path";
import { z } from "zod";
import { projectSkillRowSchema } from "../../shared/project-skills-ipc";
import { parseSkillLocationKey } from "../../domain/skill-reconciliation/validation";
import { readProjectSkillJson, writeProjectSkillJson } from "./project-skill-files";

export const parkedProjectSkillSchema = z
  .object({
    projectId: z.string(),
    rowId: z.string(),
    harnessId: z.enum(["claude-code", "codex"]),
    folderPath: z.string(),
    contentPath: z.string().regex(/^omni\/parked\/[a-f0-9-]+\/content$/u),
    row: projectSkillRowSchema,
  })
  .strict()
  .superRefine((record, context) => {
    try {
      parseSkillLocationKey({
        projectId: record.projectId,
        harnessId: record.harnessId,
        folderPath: record.folderPath,
      });
    } catch {
      context.addIssue({ code: "custom", message: "Parked skill location is invalid." });
    }
  });
export type ParkedProjectSkill = z.infer<typeof parkedProjectSkillSchema>;
export type ParkingEffect = Readonly<{ before?: ParkedProjectSkill; after?: ParkedProjectSkill }>;
export type ProjectSkillParking = Readonly<{
  read(): Promise<readonly ParkedProjectSkill[]>;
  update(effects: readonly ParkingEffect[]): Promise<void>;
}>;
const stores = new Map<string, ProjectSkillParking>();
export function parkingKey(record: Pick<ParkedProjectSkill, "projectId" | "folderPath">): string {
  return `${record.projectId}\n${record.folderPath}`;
}
export function createProjectSkillParking(userDataPath: string): ProjectSkillParking {
  const root = resolve(userDataPath);
  const existing = stores.get(root);
  if (existing) return existing;
  const read = async (): Promise<readonly ParkedProjectSkill[]> => {
    const value = await readProjectSkillJson(root, "omni/parked/index.json");
    if (value === undefined) return [];
    const records = z.array(parkedProjectSkillSchema).max(10000).parse(value);
    if (new Set(records.map(parkingKey)).size !== records.length)
      throw new Error("Parked skill locations are duplicated.");
    return records;
  };
  let queue = Promise.resolve();
  const update = (effects: readonly ParkingEffect[]): Promise<void> => {
    const result = queue.then(async () => {
      const records = [...(await read())];
      for (const effect of effects) {
        const record = effect.before ?? effect.after;
        if (!record) throw new Error("Parking effect has no identity.");
        const index = records.findIndex((item) => parkingKey(item) === parkingKey(record));
        if (JSON.stringify(index < 0 ? undefined : records[index]) !== JSON.stringify(effect.before))
          throw new Error("Parked skill metadata changed; refresh the operation.");
        if (effect.after) {
          const next = parkedProjectSkillSchema.parse(effect.after);
          if (parkingKey(next) !== parkingKey(record)) throw new Error("Parking effect changed its location.");
          if (index < 0) records.push(next);
          else records[index] = next;
        } else if (index >= 0) records.splice(index, 1);
      }
      await writeProjectSkillJson(root, "omni/parked/index.json", records);
    });
    queue = result.catch(() => undefined);
    return result;
  };
  const store = { read, update };
  stores.set(root, store);
  return store;
}
