// IPC handlers for the inference core (Brief 35a): key management, status for Settings ·
// Intelligence, and `run` for the three first commands. Suggest's deterministic input is built
// here from the same pieces the Catalogue tab and the agent gateway already use (`rank.ts`,
// `catalogue/index.ts`, the stack profile store) — this file adds no new ranking logic.

import { ipcMain, safeStorage } from "electron";

import type { CatalogueEntryView } from "../../shared/catalogue-ipc";
import {
  AI_GATEWAY_IPC_CHANNELS,
  parseAiConnectionSetRequest,
  parseAiKeySetRequest,
  parseAiFunctionsSetRequest,
  type AiConnectionResponse,
  type AiModelView,
  type AiPresetsResponse,
  type InferenceKeyMutationResponse,
} from "../../shared/ai-gateway-ipc";
import {
  INFERENCE_IPC_CHANNELS,
  parseEmptyInferenceRequest,
  parseInferenceDryRunRequest,
  parseInferenceRunRequest,
  type InferenceDryRunResponse,
  type InferenceExplainRunResponse,
  type InferenceRunRequest,
  type InferenceRunResponse,
  type InferenceSuggestItemView,
  type InferenceSuggestRunResponse,
  type InferenceSummarizeRunResponse,
} from "../../shared/inference-ipc";
import type { AiSettings } from "../../shared/settings-ipc";
import {
  buildCatalogueIndex,
  loadCatalogueSnapshot,
  marketplaceSkills,
  type CatalogueSnapshot,
} from "../catalogue/index";
import { rank, type CatalogueEntry, type RankedCatalogueEntry } from "../catalogue/rank";
import type { RegistryIpcServices } from "../registry-ipc";
import { createSettingsStore, settingsFilePath, type SettingsStore } from "../settings-store";
import { createStackProfileStore, stackProfileStoreFilePath, type StackProfileStore } from "../stack-profile-ipc";
import { createBudget, inferenceLogFilePath, type Budget } from "./budget";
import type { SuggestCommandCandidate } from "./commands/suggest";
import { buildDryRunRequest } from "./dry-run";
import { createInference } from "./index";
import type { CommandResult } from "./provider";
import type { SuggestCommandResult } from "./commands/suggest";
import { createKeyStore, inferenceKeysFilePath, type KeyStore, type SafeStorageLike } from "./keys";
import { createConnection } from "./gateway/connection";
import { listModels, testConnection, unreachableReason, type GatewayModel } from "./gateway/models";
import { PRESETS, presetFor } from "./gateway/presets";
import { resolve } from "./gateway/routes";
import { explainTask } from "./tasks/explain";
import { suggestAdaptTask } from "./tasks/suggest-adapt";
import { summarizeTask } from "./tasks/summarize";

type SenderGuard = (event: Electron.IpcMainInvokeEvent) => void;

const DEFAULT_SUGGEST_LIMIT = 8;

const unavailableSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.from("", "utf8"),
  decryptString: () => "",
};

function resolveSafeStorage(provided: SafeStorageLike | undefined): SafeStorageLike {
  if (provided) return provided;
  try {
    return safeStorage;
  } catch {
    return unavailableSafeStorage;
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Inference request failed safely.";
  return message.length <= 240 && !/[\r\n]/.test(message) && !/(?:^|[^A-Za-z0-9_])(?:\/|[A-Za-z]:[\\/])/.test(message)
    ? message
    : "Inference request failed safely.";
}

function modelView(model: GatewayModel): AiModelView {
  const maxOutputTokens = model.maxOutputTokens ?? model.maxTokens;
  const pricingIsZero = model.cost.input === 0 && model.cost.output === 0;
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    maxOutputTokens,
    tools: model.tools ?? "unknown",
    structuredOutputs: model.structuredOutputs ?? "unknown",
    free: model.free ?? (model.id.endsWith(":free") || pricingIsZero),
    pricingKnown: model.cost.input >= 0 && model.cost.output >= 0,
    // A negative registry cost means "decided per request": the view shows "prix inconnu", not -1.
    cost: { ...model.cost, input: Math.max(0, model.cost.input), output: Math.max(0, model.cost.output) },
  };
}

function toEntryView(entry: CatalogueEntry): CatalogueEntryView {
  return {
    source: entry.source,
    ownerRepo: entry.ownerRepo,
    skill: entry.skill,
    name: entry.name,
    ...(entry.description ? { description: entry.description } : {}),
    hasSkillMd: entry.path !== null,
    tags: entry.tags,
    installs: entry.installs,
    official: entry.official,
    ...(entry.packageName ? { packageName: entry.packageName } : {}),
  };
}

export type InferenceIpcOptions = Readonly<{
  userDataPath: string;
  settingsStore?: SettingsStore;
  stackProfileStore?: StackProfileStore;
  keyStore?: KeyStore;
  budget?: Budget;
  safeStorage?: SafeStorageLike;
  resourceOptions?: Parameters<typeof loadCatalogueSnapshot>[0];
}>;

export function registerInferenceIpcHandlers(
  assertTrustedSender: SenderGuard,
  registry: RegistryIpcServices,
  options: InferenceIpcOptions,
): void {
  const userDataPath = options.userDataPath;
  const settingsStore = options.settingsStore ?? createSettingsStore(settingsFilePath(userDataPath));
  const stackProfiles = options.stackProfileStore ?? createStackProfileStore(stackProfileStoreFilePath(userDataPath));
  const keys =
    options.keyStore ?? createKeyStore(inferenceKeysFilePath(userDataPath), resolveSafeStorage(options.safeStorage));
  const budget = options.budget ?? createBudget({ logFilePath: inferenceLogFilePath(userDataPath) });
  let snapshotCache: CatalogueSnapshot | undefined;
  const loadSnapshot = async (): Promise<CatalogueSnapshot> => {
    if (!snapshotCache) snapshotCache = await loadCatalogueSnapshot(options.resourceOptions);
    return snapshotCache;
  };

  const suggestCache = new Map<string, Readonly<{ outcome: CommandResult<SuggestCommandResult> }>>();
  const runSuggest = async (
    request: Extract<InferenceRunRequest, { command: "suggest" }>,
  ): Promise<InferenceSuggestRunResponse> => {
    const settings = await settingsStore.read();
    const snapshot = await loadSnapshot();
    const installed = await marketplaceSkills(registry).catch(() => []);
    const index = buildCatalogueIndex(snapshot, installed);
    const profile = (await stackProfiles.get(request.projectId).catch(() => undefined)) ?? null;
    const ranked = rank(profile, index);
    const top = ranked.slice(0, request.limit ?? DEFAULT_SUGGEST_LIMIT);
    const byKey = new Map<string, RankedCatalogueEntry>(top.map((r) => [`${r.entry.ownerRepo}/${r.entry.skill}`, r]));
    const candidates: readonly SuggestCommandCandidate[] = top.map((result) => ({
      ownerRepo: result.entry.ownerRepo,
      skill: result.entry.skill,
      name: result.entry.name,
      ...(result.entry.description ? { description: result.entry.description } : {}),
      why: result.matchedTags,
      score: result.score,
    }));
    const profileTags = (profile?.tags ?? []).map((tag) => ({
      id: tag.id,
      label: tag.label,
      evidenceCount: tag.evidence.length,
    }));

    const inference = createInference({
      userDataPath,
      settings: settings.ai,
      budget,
      readKey: () =>
        settings.ai.connection ? keys.readKey(settings.ai.connection.preset) : Promise.resolve(undefined),
    });
    // One adapted answer per (project, candidate list, connection) for the session: the project
    // page remounts its card often, and every model call costs money and may differ. A changed
    // stack or catalogue changes the candidate list, so the key changes with it.
    const cacheKey = JSON.stringify([
      request.projectId,
      request.language ?? "en",
      settings.ai.connection?.preset ?? "",
      profileTags.map((tag) => tag.id),
      candidates.map((candidate) => `${candidate.ownerRepo}/${candidate.skill}`),
    ]);
    const cached = request.bypassCache ? undefined : suggestCache.get(cacheKey);
    const { outcome } =
      cached ??
      (await inference.runCommand({
        command: "suggest",
        input: { profileTags, candidates, ...(request.language ? { language: request.language } : {}) },
      }));
    if (!request.bypassCache && !cached && outcome.intelligence === "ok") suggestCache.set(cacheKey, { outcome });
    // Every item in the result came from `candidates`, which came from `top`: the lookup below
    // always hits — a defensive fallback would only hide a real bug in that invariant.
    const items: InferenceSuggestItemView[] = outcome.result.items.map((item) => {
      const matched = byKey.get(`${item.ownerRepo}/${item.skill}`);
      if (!matched) throw new Error("A suggested item did not come from the ranked candidates.");
      return {
        entry: toEntryView(matched.entry),
        score: item.score,
        matchedTags: item.why,
        adapted: item.adapted,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
      };
    });
    return {
      command: "suggest",
      intelligence: outcome.intelligence,
      ...("reason" in outcome ? { reason: outcome.reason } : {}),
      items,
    };
  };

  const runExplain = async (
    request: Extract<InferenceRunRequest, { command: "explain" }>,
  ): Promise<InferenceExplainRunResponse> => {
    const settings = await settingsStore.read();
    const inference = createInference({
      userDataPath,
      settings: settings.ai,
      budget,
      readKey: () =>
        settings.ai.connection ? keys.readKey(settings.ai.connection.preset) : Promise.resolve(undefined),
    });
    const { outcome } = await inference.runCommand({
      command: "explain",
      input: { findingKind: request.findingKind, left: request.left, right: request.right },
    });
    return {
      command: "explain",
      intelligence: outcome.intelligence,
      ...("reason" in outcome ? { reason: outcome.reason } : {}),
      ...(outcome.result.explanation === undefined ? {} : { explanation: outcome.result.explanation }),
      ...(outcome.result.keep === undefined ? {} : { keep: outcome.result.keep }),
    };
  };

  const runSummarize = async (
    request: Extract<InferenceRunRequest, { command: "summarize" }>,
  ): Promise<InferenceSummarizeRunResponse> => {
    const settings = await settingsStore.read();
    const inference = createInference({
      userDataPath,
      settings: settings.ai,
      budget,
      readKey: () =>
        settings.ai.connection ? keys.readKey(settings.ai.connection.preset) : Promise.resolve(undefined),
    });
    const { outcome } = await inference.runCommand({
      command: "summarize",
      input: { kind: request.kind, lines: request.lines },
    });
    return {
      command: "summarize",
      intelligence: outcome.intelligence,
      ...("reason" in outcome ? { reason: outcome.reason } : {}),
      ...(outcome.result.sentence === undefined ? {} : { sentence: outcome.result.sentence }),
    };
  };

  const guard =
    <T>(handler: (request: unknown) => Promise<T>) =>
    async (event: Electron.IpcMainInvokeEvent, request: unknown): Promise<T> => {
      assertTrustedSender(event);
      try {
        return await handler(request);
      } catch (error: unknown) {
        throw new Error(safeError(error));
      }
    };

  const writeAi = async (ai: AiSettings): Promise<AiSettings> => {
    const current = await settingsStore.read();
    const next = await settingsStore.set({
      commitChanges: current.git.commitChanges,
      agents: current.agents,
      ai,
      features: current.features,
      externalLibrary: current.externalLibrary,
    });
    return next.ai;
  };
  const aiConnectionResponse = async (): Promise<AiConnectionResponse> => {
    const settings = await settingsStore.read();
    const connection = settings.ai.connection;
    const keyState = connection ? ((await keys.hasKey(connection.preset)) ? "set" : "none") : "none";
    return {
      ...(connection ? { connection } : {}),
      keyState,
      ...(connection ? { scope: presetFor(connection.preset).scope } : {}),
    };
  };
  ipcMain.handle(
    AI_GATEWAY_IPC_CHANNELS.connectionGet,
    guard(async (raw): Promise<AiConnectionResponse> => {
      parseEmptyInferenceRequest(raw);
      return aiConnectionResponse();
    }),
  );
  ipcMain.handle(
    AI_GATEWAY_IPC_CHANNELS.connectionSet,
    guard(async (raw): Promise<AiConnectionResponse> => {
      const request = parseAiConnectionSetRequest(raw);
      await writeAi({
        ...(await settingsStore.read()).ai,
        connection: createConnection(request.preset, request.baseUrl),
      });
      return aiConnectionResponse();
    }),
  );
  ipcMain.handle(
    AI_GATEWAY_IPC_CHANNELS.connectionRemove,
    guard(async (raw): Promise<AiConnectionResponse> => {
      parseEmptyInferenceRequest(raw);
      const ai = (await settingsStore.read()).ai;
      const { connection: _removed, ...withoutConnection } = ai;
      await writeAi(withoutConnection);
      return aiConnectionResponse();
    }),
  );
  ipcMain.handle(
    AI_GATEWAY_IPC_CHANNELS.keySet,
    guard(async (raw): Promise<InferenceKeyMutationResponse> => {
      const request = parseAiKeySetRequest(raw);
      const connection = (await settingsStore.read()).ai.connection;
      if (!connection) return { status: "unavailable", reason: "Add a connection in Settings · AI." };
      return keys.setKey(connection.preset, request.key);
    }),
  );
  ipcMain.handle(
    AI_GATEWAY_IPC_CHANNELS.keyRemove,
    guard(async (raw): Promise<InferenceKeyMutationResponse> => {
      parseEmptyInferenceRequest(raw);
      const connection = (await settingsStore.read()).ai.connection;
      if (!connection) return { status: "ok" };
      return keys.clearKey(connection.preset);
    }),
  );
  ipcMain.handle(
    AI_GATEWAY_IPC_CHANNELS.connectionTest,
    guard(async (raw) => {
      parseEmptyInferenceRequest(raw);
      const connection = (await settingsStore.read()).ai.connection;
      if (!connection) return { status: "unreachable" as const, reason: "Add a connection in Settings · AI." };
      const result = await testConnection(connection, {
        readKey: () => keys.readKey(connection.preset),
        userDataPath,
      });
      return result.status === "reachable" ? { status: result.status, models: result.models.map(modelView) } : result;
    }),
  );
  ipcMain.handle(
    AI_GATEWAY_IPC_CHANNELS.models,
    guard(async (raw) => {
      parseEmptyInferenceRequest(raw);
      const connection = (await settingsStore.read()).ai.connection;
      if (!connection) return { models: [] };
      try {
        const models = await listModels(connection, {
          userDataPath,
          readKey: () => keys.readKey(connection.preset),
        });
        return { models: models.map(modelView) };
      } catch (error: unknown) {
        // An unreachable endpoint is a state the card shows, never a thrown bridge error.
        return { models: [], unavailable: unreachableReason(error, connection) };
      }
    }),
  );
  ipcMain.handle(
    AI_GATEWAY_IPC_CHANNELS.functionsSet,
    guard(async (raw) => {
      const request = parseAiFunctionsSetRequest(raw);
      const ai = (await settingsStore.read()).ai;
      const next = await writeAi({ ...ai, functions: request.functions });
      return { functions: next.functions };
    }),
  );
  ipcMain.handle(
    AI_GATEWAY_IPC_CHANNELS.usage,
    guard(async (raw) => {
      parseEmptyInferenceRequest(raw);
      return budget.usageThisMonth();
    }),
  );
  ipcMain.handle(
    AI_GATEWAY_IPC_CHANNELS.presets,
    guard(async (raw): Promise<AiPresetsResponse> => {
      parseEmptyInferenceRequest(raw);
      return {
        presets: Object.values(PRESETS).map((preset) => ({
          id: preset.id,
          displayName: preset.displayName,
          keyPlaceholder: preset.keyPlaceholder,
          scope: preset.scope,
          keyRequired: preset.keyRequired,
          ...(preset.openAiCompatible?.defaultBaseUrl
            ? { defaultBaseUrl: preset.openAiCompatible.defaultBaseUrl }
            : {}),
        })),
      };
    }),
  );

  ipcMain.handle(
    INFERENCE_IPC_CHANNELS.run,
    guard(async (raw): Promise<InferenceRunResponse> => {
      const request = parseInferenceRunRequest(raw);
      if (request.command === "suggest") return runSuggest(request);
      if (request.command === "explain") return runExplain(request);
      return runSummarize(request);
    }),
  );
  ipcMain.handle(
    INFERENCE_IPC_CHANNELS.dryRun,
    guard(async (raw): Promise<InferenceDryRunResponse> => {
      const request = parseInferenceDryRunRequest(raw);
      const settings = await settingsStore.read();
      const connection = settings.ai.connection;
      if (!connection) throw new Error("Add a connection in Settings · AI.");
      const models = await listModels(connection, {
        userDataPath,
        readKey: () => keys.readKey(connection.preset),
      });
      const task = request.command === "suggest" ? "suggest-adapt" : request.command;
      const route = resolve(task, connection, models, settings.ai.functions);
      if (route.status !== "ready") throw new Error(route.reason);
      const call =
        request.command === "suggest"
          ? {
              task,
              system: suggestAdaptTask.system,
              input: suggestAdaptTask.buildInput(request.input),
              schema: suggestAdaptTask.schema,
              maxOutputTokens: 600,
              model: route.model,
              connection,
            }
          : request.command === "explain"
            ? {
                task,
                system: explainTask.system,
                input: explainTask.buildInput(request.input),
                schema: explainTask.schema,
                maxOutputTokens: 200,
                model: route.model,
                connection,
              }
            : {
                task,
                system: summarizeTask.system,
                input: summarizeTask.buildInput(request.input),
                schema: summarizeTask.schema,
                maxOutputTokens: 120,
                model: route.model,
                connection,
              };
      return buildDryRunRequest(call as never);
    }),
  );
}
