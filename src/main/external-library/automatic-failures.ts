import { z } from "zod";
import { readRegularFile, writeAtomically } from "../operation-files";
import {
  externalAutomaticFailureSchema,
  type ExternalAutomaticFailure,
  type ExternalUse,
} from "../../shared/external-library-ipc";
import type { ExternalLibraryObservation } from "./reader";

const record = z.object({ useId: z.string().min(1).max(256), failure: externalAutomaticFailureSchema }).strict();
const schema = z.object({ schemaVersion: z.literal(1), failures: z.array(record).max(10000) }).strict();
export interface ExternalAutomaticFailures {
  overlay(observation: ExternalLibraryObservation): Promise<ExternalLibraryObservation>;
  record(outcomes: readonly Readonly<{ useId: string; failure?: ExternalAutomaticFailure }>[]): Promise<void>;
}

export function skipsAutomaticFailure(use: ExternalUse, sourceHead: string): boolean {
  return use.lastAutomaticFailure?.sourceHead === sourceHead && use.lastAutomaticFailure.copyHash === use.copyHash;
}

export function createExternalAutomaticFailures(userDataPath: string): ExternalAutomaticFailures {
  const path = "omni/external-library-automatic-failures.json";
  const read = async (): Promise<Map<string, ExternalAutomaticFailure>> => {
    const bytes = await readRegularFile(userDataPath, path);
    const state = bytes ? schema.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))) : { failures: [] };
    return new Map(state.failures.map((entry) => [entry.useId, entry.failure]));
  };
  let queue = Promise.resolve();
  return {
    overlay: async (observation) => {
      const failures = await read();
      return {
        ...observation,
        sources: observation.sources.map((source) => ({
          ...source,
          uses: source.uses.map((use) => {
            const { lastAutomaticFailure: _previous, ...current } = use;
            const failure = failures.get(use.id);
            return failure ? { ...current, lastAutomaticFailure: failure } : current;
          }),
        })),
      };
    },
    record: (outcomes) => {
      const operation = queue.then(async () => {
        const failures = await read();
        for (const outcome of outcomes) {
          if (outcome.failure) failures.set(outcome.useId, outcome.failure);
          else failures.delete(outcome.useId);
        }
        await writeAtomically(
          userDataPath,
          path,
          JSON.stringify(
            schema.parse({
              schemaVersion: 1,
              failures: [...failures].map(([useId, failure]) => ({ useId, failure })),
            }),
          ) + "\n",
        );
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
  };
}
