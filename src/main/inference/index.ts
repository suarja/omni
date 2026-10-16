import { createBudget, inferenceLogFilePath, type Budget, type UsageSummary } from "./budget";
import type { DataCategoryPreferences } from "./data-categories";
import { runExplainCommand, type ExplainCommandResult } from "./commands/explain";
import { runSuggestCommand, type SuggestCommandInput, type SuggestCommandResult } from "./commands/suggest";
import { runSummarizeCommand, type SummarizeCommandResult } from "./commands/summarize";
import { listModels, type GatewayModel } from "./gateway/models";
import { resolve } from "./gateway/routes";
import { createPiProvider, type PiComplete } from "./providers/pi";
import { createNoneProvider } from "./providers/none";
import type { AiSettings } from "../../shared/settings-ipc";
import type { TaskId } from "../../shared/inference-ipc";
import type { CommandResult, InferenceProvider } from "./provider";
import type { ExplainInput } from "./tasks/explain";
import type { SummarizeInput } from "./tasks/summarize";

export type InferenceSettings = AiSettings;
export type InferenceRunRequest =
  | Readonly<{ command: "suggest"; input: SuggestCommandInput }>
  | Readonly<{ command: "explain"; input: ExplainInput }>
  | Readonly<{ command: "summarize"; input: SummarizeInput }>;
export type InferenceRunResult =
  | Readonly<{ command: "suggest"; outcome: CommandResult<SuggestCommandResult> }>
  | Readonly<{ command: "explain"; outcome: CommandResult<ExplainCommandResult> }>
  | Readonly<{ command: "summarize"; outcome: CommandResult<SummarizeCommandResult> }>;
export type RunInferenceCommand = {
  (
    request: Extract<InferenceRunRequest, { command: "suggest" }>,
  ): Promise<Extract<InferenceRunResult, { command: "suggest" }>>;
  (
    request: Extract<InferenceRunRequest, { command: "explain" }>,
  ): Promise<Extract<InferenceRunResult, { command: "explain" }>>;
  (
    request: Extract<InferenceRunRequest, { command: "summarize" }>,
  ): Promise<Extract<InferenceRunResult, { command: "summarize" }>>;
};
export type Inference = Readonly<{
  provider: InferenceProvider;
  runCommand: RunInferenceCommand;
  usageThisMonth(): Promise<UsageSummary>;
}>;
export type CreateInferenceOptions = Readonly<{
  userDataPath: string;
  settings: InferenceSettings;
  budget?: Budget;
  readKey?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  completeImpl?: PiComplete;
  listModelsImpl?: (connection: NonNullable<InferenceSettings["connection"]>) => Promise<readonly GatewayModel[]>;
}>;

const DISABLED_REASON = "This command is turned off in Settings · AI.";
const NO_CONNECTION_REASON = "Add a connection in Settings · AI.";

function disabledResult(request: InferenceRunRequest): InferenceRunResult {
  const unavailable = { intelligence: "unavailable" as const, reason: DISABLED_REASON };
  if (request.command === "suggest")
    return {
      command: request.command,
      outcome: {
        ...unavailable,
        result: { items: request.input.candidates.map((candidate) => ({ ...candidate, adapted: false })) },
      },
    };
  return { command: request.command, outcome: { ...unavailable, result: {} } } as InferenceRunResult;
}
function noRouteResult(request: InferenceRunRequest, reason: string): InferenceRunResult {
  const unavailable = { intelligence: "unavailable" as const, reason };
  if (request.command === "suggest")
    return {
      command: request.command,
      outcome: {
        ...unavailable,
        result: { items: request.input.candidates.map((candidate) => ({ ...candidate, adapted: false })) },
      },
    };
  return { command: request.command, outcome: { ...unavailable, result: {} } } as InferenceRunResult;
}

export function createInference(options: CreateInferenceOptions): Inference {
  const connection = options.settings.connection;
  const provider = connection
    ? createPiProvider({
        connection,
        readKey: options.readKey ?? (async () => undefined),
        completeImpl: options.completeImpl,
      })
    : createNoneProvider();
  const budget = options.budget ?? createBudget({ logFilePath: inferenceLogFilePath(options.userDataPath) });
  const preferences: DataCategoryPreferences = options.settings.dataCategories;
  const findModels =
    options.listModelsImpl ??
    ((candidate: NonNullable<typeof connection>) =>
      listModels(candidate, { fetch: options.fetchImpl, readKey: options.readKey }));

  const runCommand = async (request: InferenceRunRequest): Promise<InferenceRunResult> => {
    if (!options.settings.commands[request.command]) return disabledResult(request);
    if (!connection) return noRouteResult(request, NO_CONNECTION_REASON);
    let models: readonly GatewayModel[];
    try {
      models = await findModels(connection);
    } catch (error: unknown) {
      return noRouteResult(
        request,
        error instanceof Error ? error.message.slice(0, 200) : "The connection is unavailable.",
      );
    }
    const task: TaskId = request.command === "suggest" ? "suggest-adapt" : request.command;
    const route = resolve(task, connection, models, options.settings.functions);
    if (route.status !== "ready") return noRouteResult(request, route.reason);
    const common = { provider, budget, dataCategoryPreferences: preferences, model: route.model, connection };
    if (request.command === "suggest")
      return {
        command: request.command,
        outcome: await runSuggestCommand(
          request.input,
          common.provider,
          common.budget,
          common.dataCategoryPreferences,
          common.model,
          common.connection,
        ),
      };
    if (request.command === "explain")
      return {
        command: request.command,
        outcome: await runExplainCommand(
          request.input,
          common.provider,
          common.budget,
          common.dataCategoryPreferences,
          common.model,
          common.connection,
        ),
      };
    return {
      command: request.command,
      outcome: await runSummarizeCommand(
        request.input,
        common.provider,
        common.budget,
        common.dataCategoryPreferences,
        common.model,
        common.connection,
      ),
    };
  };
  return { provider, runCommand: runCommand as RunInferenceCommand, usageThisMonth: budget.usageThisMonth };
}
