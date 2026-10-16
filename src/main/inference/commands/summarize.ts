// Summarize's pipeline (Brief 35a): a session's Task-card evidence or a receipt's actions in,
// one bounded model step, a sentence out. With the `none` provider, the result is empty — the
// "Doing: …" line never appears.

import type { Budget } from "../budget";
import type { DataCategoryPreferences } from "../data-categories";
import type { CommandResult, InferenceProvider } from "../provider";
import type { Connection } from "../../../shared/ai-gateway-ipc";
import type { GatewayModel } from "../gateway/models";
import { summarizeTask, type SummarizeInput } from "../tasks/summarize";

/** Exported so `dry-run.ts` (Brief 35b) builds the exact request this command would send. */
export const MAX_OUTPUT_TOKENS = 120;

export type SummarizeCommandResult = Readonly<{ sentence?: string }>;

export async function runSummarizeCommand(
  input: SummarizeInput,
  provider: InferenceProvider,
  budget: Budget,
  dataCategoryPreferences: DataCategoryPreferences,
  model?: GatewayModel,
  connection?: Connection,
): Promise<CommandResult<SummarizeCommandResult>> {
  const deterministic: SummarizeCommandResult = {};
  if (input.lines.length === 0) {
    return { intelligence: "unavailable", reason: "No evidence to summarize.", result: deterministic };
  }
  const outcome = await budget.run({
    provider,
    task: summarizeTask,
    system: summarizeTask.system,
    input: summarizeTask.buildInput(input),
    schema: summarizeTask.schema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    dataCategoryPreferences,
    model,
    connection,
  });
  if (outcome.status !== "ok") {
    return { intelligence: outcome.status, reason: outcome.reason, result: deterministic };
  }
  return { intelligence: "ok", result: { sentence: outcome.value.sentence } };
}
