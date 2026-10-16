import { z } from "zod";
import { readRegularFile, writeAtomically } from "../operation-files";
import type { ExternalLibraryObservation } from "./reader";
import type { ExternalUse } from "../../shared/external-library-ipc";

const record = z
  .object({
    sourceId: z.string().max(256),
    projectId: z.string().max(128),
    skillKey: z.string().max(128),
    deletingCommit: z.string().regex(/^[0-9a-f]{40,64}$/u),
  })
  .strict();
const state = z.object({ schemaVersion: z.literal(1), acknowledgements: z.array(record).max(10000) }).strict();
type Acknowledgement = z.infer<typeof record>;
const key = (value: Acknowledgement): string =>
  JSON.stringify([value.sourceId, value.projectId, value.skillKey, value.deletingCommit]);
const forUse = (use: ExternalUse): Acknowledgement | undefined =>
  use.removal
    ? { sourceId: use.sourceId, projectId: use.projectId, skillKey: use.skillKey, deletingCommit: use.removal.commit }
    : undefined;

export function createExternalAcknowledgements(userDataPath: string): Readonly<{
  acknowledge(use: ExternalUse): Promise<void>;
  overlay(observation: ExternalLibraryObservation): Promise<ExternalLibraryObservation>;
}> {
  const path = "omni/external-library-actions.json";
  let queue = Promise.resolve();
  const read = async (): Promise<Acknowledgement[]> => {
    const bytes = await readRegularFile(userDataPath, path);
    return bytes ? state.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))).acknowledgements : [];
  };
  return {
    acknowledge: (use) => {
      const operation = queue.then(async () => {
        const acknowledgement = forUse(use);
        if (use.state !== "removed" || !acknowledgement)
          throw new Error("Only a verified upstream deletion can be acknowledged. Check the library again.");
        const entries = new Map((await read()).map((entry) => [key(entry), entry]));
        entries.set(key(acknowledgement), acknowledgement);
        await writeAtomically(
          userDataPath,
          path,
          JSON.stringify(state.parse({ schemaVersion: 1, acknowledgements: [...entries.values()] })) + "\n",
        );
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
    overlay: async (observation) => {
      const keys = new Set((await read()).map(key));
      return {
        ...observation,
        sources: observation.sources.map((source) => {
          const uses = source.uses.map((use) => {
            const value = forUse(use);
            return use.state === "removed" && value && keys.has(key(value))
              ? { ...use, acknowledged: true as const }
              : use;
          });
          return {
            ...source,
            uses,
            ...(source.source
              ? {
                  source: {
                    ...source.source,
                    counts: {
                      ...source.source.counts,
                      removed: uses.filter((use) => use.state === "removed" && !use.acknowledged).length,
                    },
                  },
                }
              : {}),
          };
        }),
      };
    },
  };
}
