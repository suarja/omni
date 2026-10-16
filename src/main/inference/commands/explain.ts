// Explain's pipeline (Brief 35a): a finding's two sides in, one bounded model step, a sentence
// out. With the `none` provider, the result is empty — the finding renders exactly as it does
// today, with no sentence underneath it.

import type { Budget } from "../budget";
import type { DataCategoryPreferences } from "../data-categories";
import type { CommandResult, InferenceProvider } from "../provider";
import type { Connection } from "../../../shared/ai-gateway-ipc";
import type { GatewayModel } from "../gateway/models";
import { explainTask, type ExplainInput, type ExplainOutput } from "../tasks/explain";

/** Exported so `dry-run.ts` (Brief 35b) builds the exact request this command would send. */
export const MAX_OUTPUT_TOKENS = 200;

export type ExplainCommandResult = Readonly<{ explanation?: string; keep?: ExplainOutput["keep"] }>;

export async function runExplainCommand(
  input: ExplainInput,
  provider: InferenceProvider,
  budget: Budget,
  dataCategoryPreferences: DataCategoryPreferences,
  model?: GatewayModel,
  connection?: Connection,
): Promise<CommandResult<ExplainCommandResult>> {
  const deterministic: ExplainCommandResult = {};
  const outcome = await budget.run({
    provider,
    task: explainTask,
    system: explainTask.system,
    input: explainTask.buildInput(input),
    schema: explainTask.schema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    dataCategoryPreferences,
    model,
    connection,
  });
  if (outcome.status !== "ok") {
    return { intelligence: outcome.status, reason: outcome.reason, result: deterministic };
  }
  return { intelligence: "ok", result: { explanation: outcome.value.explanation, keep: outcome.value.keep } };
}
