import { parseExternalPass, type ExternalPass, type ExternalLibraryList } from "../../shared/external-library-ipc";
import { classifyGitFailure } from "../git-command";
import { detectExternalUses } from "./detection";
import { checkExternalReadCopy, type ExternalReadCopyOptions } from "./read-copy";
import { observeExternalLibrary, readExternalRegistry } from "./reader";
import type { ExternalSourcesStore } from "./store";
import { externalReadCopyFolder } from "../../domain/external-library";
import type { ExternalLibraryObservation } from "./reader";

export async function checkExternalLibrarySources(
  options: ExternalReadCopyOptions,
  store: ExternalSourcesStore,
): Promise<{ pass: ExternalPass; observation?: ExternalLibraryObservation }> {
  const startedAt = new Date((options.now ?? Date.now)()).toISOString();
  const diagnostics: ExternalLibraryList["diagnostics"] = [];
  let result: ExternalPass["result"] = "success";
  let observation: ExternalLibraryObservation | undefined;
  try {
    const detected = await detectExternalUses(await readExternalRegistry(options));
    diagnostics.push(...detected.diagnostics.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)));
    const existing = new Set((await store.read()).sources.map((source) => source.repo));
    for (const use of detected.uses) {
      const repo = use.entry.source.locator;
      if (!existing.has(repo)) {
        await store.upsert({ repo, arrival: "detected", readCopyFolder: externalReadCopyFolder(repo) });
        existing.add(repo);
      }
    }
    for (const source of (await store.read()).sources) await checkExternalReadCopy(options, store, source);
    observation = await observeExternalLibrary(options, store);
    for (const source of observation.sources) if (source.source?.lastError) diagnostics.push(source.source.lastError);
    if (diagnostics.length) result = "partial";
  } catch (error) {
    result = "failed";
    diagnostics.push(classifyGitFailure(error));
  }
  return {
    observation,
    pass: parseExternalPass({
      startedAt,
      finishedAt: new Date((options.now ?? Date.now)()).toISOString(),
      result,
      errors: diagnostics.length,
      diagnostics,
    }),
  };
}
