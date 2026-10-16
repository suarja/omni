import { join } from "node:path";
import type { SkillManagementService } from "../../application/skill-management";
import { createSettingsStore, settingsFilePath } from "../settings-store";
import { createExternalAcknowledgements } from "./acknowledgements";
import { applyAutomaticExternalUpdates } from "./automatic-updates";
import { createExternalAutomaticFailures } from "./automatic-failures";
import { createExternalMergeRetention } from "./merge-retention";
import { parseExternalRepository, externalReadCopyFolder } from "../../domain/external-library";
import {
  parseExternalSourceAddResult,
  type ExternalLibraryList,
  type ExternalSourceDetails,
  type ExternalComparison,
  type ExternalMacSources,
  type ExternalSourceAddResult,
  type ExternalPass,
} from "../../shared/external-library-ipc";
import { classifyGitFailure } from "../git-command";
import { createExternalSourcesStore, type ExternalSourcesStore } from "./store";
import { checkExternalReadCopy, type ExternalReadCopyOptions } from "./read-copy";
import { observeExternalLibrary, type ExternalLibraryObservation } from "./reader";
import { readPersistedExternalSnapshot, publishExternalSnapshot, clearExternalSnapshot } from "./snapshot";
import type { ExternalRecoveredBase } from "./base-recovery";
import { checkExternalLibrarySources } from "./pass";
import {
  readExternalLibraryList,
  readExternalSourceDetails,
  readExternalLibraryComparison,
  readExternalMacPresentation,
} from "./read-model";

export type ExternalLibraryOptions = ExternalReadCopyOptions &
  Readonly<{
    homeDir?: string;
    isPackaged?: boolean;
    onChanged?: () => void;
  }>;
export interface ExternalLibraryService {
  bindOperations(service: SkillManagementService): void;
  acknowledgeRemoved(useId: string): Promise<ExternalSourceDetails>;
  operationObservation(): Promise<ExternalLibraryObservation>;
  refreshCopies(): Promise<void>;
  list(): Promise<ExternalLibraryList>;
  readSource(sourceId: string): Promise<ExternalSourceDetails>;
  compare(useId: string): Promise<ExternalComparison>;
  onMac(): Promise<ExternalMacSources>;
  add(repository: string): Promise<ExternalSourceAddResult>;
  check(): Promise<ExternalPass>;
}
export function createExternalLibraryService(options: ExternalLibraryOptions): ExternalLibraryService {
  const store = createExternalSourcesStore(join(options.userDataPath, "omni/external-sources.json"));
  const acknowledgements = createExternalAcknowledgements(options.userDataPath);
  const automaticFailures = createExternalAutomaticFailures(options.userDataPath);
  const retainedMerges = createExternalMergeRetention(options.userDataPath);
  const settings = createSettingsStore(settingsFilePath(options.userDataPath));
  let operations: SkillManagementService | undefined;
  let lastPass: ExternalPass | undefined, active: Promise<ExternalPass> | undefined;
  let observation: ExternalLibraryObservation | undefined;
  let mac: Promise<ExternalMacSources> | undefined;
  const bases = new Map<string, Promise<ExternalRecoveredBase>>();
  clearExternalSnapshot(options.userDataPath);
  const getObservation = async (): Promise<ExternalLibraryObservation> =>
    automaticFailures.overlay(
      await acknowledgements.overlay(observation ?? (await readPersistedExternalSnapshot(options, store))),
    );
  const publish = async (next: ExternalLibraryObservation): Promise<ExternalLibraryObservation> => {
    if (operations) next = await retainedMerges.observe(next);
    observation = next;
    publishExternalSnapshot(options.userDataPath, next);
    return next;
  };
  let queue = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const applyUpdates = async (pass: ExternalPass, checked: ExternalLibraryObservation): Promise<ExternalPass> => {
    if (!operations || (await settings.read()).externalLibrary.updates !== "auto") return pass;
    const applied = await applyAutomaticExternalUpdates(
      operations,
      await automaticFailures.overlay(checked),
      automaticFailures,
      options.now,
    );
    return {
      ...pass,
      updates: applied.updates,
      finishedAt: new Date((options.now ?? Date.now)()).toISOString(),
      diagnostics: [...pass.diagnostics, ...applied.diagnostics],
      errors: pass.errors + applied.diagnostics.length,
      result: applied.diagnostics.length && pass.result === "success" ? "partial" : pass.result,
    };
  };
  const run = async (): Promise<ExternalPass> => {
    options.onChanged?.();
    const result = await checkExternalLibrarySources(options, store);
    lastPass = result.pass;
    let checked: ExternalLibraryObservation | undefined;
    if (result.observation) {
      checked = await publish(result.observation);
      const diagnostics = checked.diagnostics.slice(result.observation.diagnostics.length);
      if (diagnostics.length)
        lastPass = {
          ...lastPass,
          result: "partial",
          errors: lastPass.errors + diagnostics.length,
          diagnostics: [...lastPass.diagnostics, ...diagnostics],
        };
    } else {
      observation = undefined;
      clearExternalSnapshot(options.userDataPath);
    }
    if (checked) lastPass = await applyUpdates(lastPass, checked);
    mac = readExternalMacPresentation(options);
    await mac;
    return lastPass;
  };
  return {
    bindOperations: (service) => {
      operations = service;
    },
    acknowledgeRemoved: (useId) =>
      serialized(async () => {
        const current = await getObservation();
        const use = current.sources.flatMap((source) => source.uses).find((use) => use.id === useId);
        if (!use) throw new Error("The removed external use is unavailable. Check the library again.");
        await acknowledgements.acknowledge(use);
        options.onChanged?.();
        return readExternalSourceDetails(getObservation, use.sourceId);
      }),
    operationObservation: getObservation,
    refreshCopies: async () => {
      await publish(await observeExternalLibrary(options, store));
      options.onChanged?.();
    },
    list: () => readExternalLibraryList(getObservation, { lastPass, checking: Boolean(active) }),
    readSource: (id) => readExternalSourceDetails(getObservation, id),
    onMac: () => (mac ??= readExternalMacPresentation(options)),
    compare: (id) => serialized(() => readExternalLibraryComparison(getObservation, id, bases)),
    add: (repository) =>
      serialized(async () => {
        const repo = parseExternalRepository(repository);
        const startedAt = new Date((options.now ?? Date.now)()).toISOString();
        try {
          const previous = (await store.read()).sources.find((source) => source.repo === repo);
          const source = { ...previous, repo, arrival: "owner" as const, readCopyFolder: externalReadCopyFolder(repo) };
          await store.upsert(source);
          await checkExternalReadCopy(options, store, source);
          await publish(await observeExternalLibrary(options, store));
          if (operations) {
            const checked = await getObservation();
            const sources = checked.sources.filter((entry) => entry.source?.id === repo);
            const diagnostics = [...checked.diagnostics, ...sources.flatMap((entry) => entry.source?.lastError ?? [])];
            lastPass = await applyUpdates(
              {
                startedAt,
                finishedAt: new Date((options.now ?? Date.now)()).toISOString(),
                result: diagnostics.length ? "partial" : "success",
                errors: diagnostics.length,
                diagnostics,
              },
              { ...checked, sources },
            );
          }
          mac = readExternalMacPresentation(options);
          const details = await readExternalSourceDetails(getObservation, repo);
          return parseExternalSourceAddResult({
            ...details,
            status: details.source?.lastError ? "failed" : "added",
            marketplaceMatches: (await mac).marketplaces.filter((marketplace) => marketplace.repo === repo),
            error: details.source?.lastError,
          });
        } catch (error) {
          return {
            status: "failed" as const,
            skills: [],
            uses: [],
            marketplaceMatches: [],
            error: classifyGitFailure(error),
          };
        } finally {
          options.onChanged?.();
        }
      }),
    check: () => {
      if (!active)
        active = serialized(run).finally(() => {
          active = undefined;
          options.onChanged?.();
        });
      return active;
    },
  };
}
