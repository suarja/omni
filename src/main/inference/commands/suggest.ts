// Suggest's pipeline (Brief 35a): deterministic ranked candidates in, one bounded model step,
// deterministic result out. With the `none` provider (or any refusal/failure), the result is the
// ranked list unchanged — the card renders exactly as it does today.

import type { Budget } from "../budget";
import type { DataCategoryPreferences } from "../data-categories";
import type { CommandResult, InferenceProvider } from "../provider";
import type { Connection } from "../../../shared/ai-gateway-ipc";
import type { GatewayModel } from "../gateway/models";
import { suggestAdaptTask, type SuggestAdaptCandidate, type SuggestAdaptProfileTag } from "../tasks/suggest-adapt";

const MAX_CANDIDATES_TO_ADAPT = 8;
/** Exported so `dry-run.ts` (Brief 35b) builds the exact request this command would send. */
export const MAX_OUTPUT_TOKENS = 600;

export type SuggestCommandCandidate = SuggestAdaptCandidate & Readonly<{ score: number }>;

export type SuggestCommandInput = Readonly<{
  profileTags: readonly SuggestAdaptProfileTag[];
  candidates: readonly SuggestCommandCandidate[];
  language?: "en" | "fr";
}>;

export type SuggestCommandItem = SuggestCommandCandidate & Readonly<{ adapted: boolean; reason?: string }>;

export type SuggestCommandResult = Readonly<{ items: readonly SuggestCommandItem[] }>;

function candidateKey(candidate: Readonly<{ ownerRepo: string; skill: string }>): string {
  return `${candidate.ownerRepo}/${candidate.skill}`;
}

function resolveCandidate<T extends Readonly<{ ownerRepo: string; skill: string }>>(
  pick: Readonly<{ ownerRepo: string; skill: string }>,
  candidates: readonly T[],
): T | undefined {
  const key = candidateKey(pick).toLowerCase();
  const exact = candidates.find((candidate) => candidateKey(candidate).toLowerCase() === key);
  if (exact) return exact;
  const bySkill = candidates.filter((candidate) => candidate.skill.toLowerCase() === pick.skill.toLowerCase());
  if (bySkill.length === 1) return bySkill[0];
  return candidates.find((candidate) => key.endsWith(candidateKey(candidate).toLowerCase()));
}

export async function runSuggestCommand(
  input: SuggestCommandInput,
  provider: InferenceProvider,
  budget: Budget,
  dataCategoryPreferences: DataCategoryPreferences,
  model?: GatewayModel,
  connection?: Connection,
): Promise<CommandResult<SuggestCommandResult>> {
  const deterministic: SuggestCommandResult = {
    items: input.candidates.map((candidate) => ({ ...candidate, adapted: false })),
  };
  const toAdapt = input.candidates.slice(0, MAX_CANDIDATES_TO_ADAPT);
  if (toAdapt.length === 0) {
    return { intelligence: "unavailable", reason: "No candidates to adapt.", result: deterministic };
  }

  const outcome = await budget.run({
    provider,
    task: suggestAdaptTask,
    system: suggestAdaptTask.system,
    input: suggestAdaptTask.buildInput({
      profileTags: input.profileTags,
      candidates: toAdapt,
      ...(input.language ? { language: input.language } : {}),
    }),
    schema: suggestAdaptTask.schema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    dataCategoryPreferences,
    model,
    connection,
  });
  if (outcome.status !== "ok") {
    return { intelligence: outcome.status, reason: outcome.reason, result: deterministic };
  }

  // Models echo the candidate line loosely ("clerk/skills/clerk-setup", "clerk-setup" alone…):
  // resolve each pick to one given candidate by exact key, then by unique skill name, then by
  // the candidate key as a suffix of what came back — never to a candidate that was not offered.
  const resolved = outcome.value.picks.flatMap((pick) => {
    const candidate = resolveCandidate(pick, toAdapt);
    return candidate ? [{ key: candidateKey(candidate), reason: pick.reason }] : [];
  });
  if (resolved.length === 0) {
    const returned = outcome.value.picks
      .slice(0, 5)
      .map((pick) => candidateKey(pick))
      .join(", ");
    return {
      intelligence: "invalid-output",
      reason: `The model picked no candidate from the given list (returned: ${returned || "nothing"}).`,
      result: deterministic,
    };
  }

  const reasonByKey = new Map(resolved.map((pick) => [pick.key, pick.reason]));
  return {
    intelligence: "ok",
    result: {
      items: deterministic.items.map((item) => {
        const reason = reasonByKey.get(candidateKey(item));
        return reason === undefined ? item : { ...item, adapted: true, reason };
      }),
    },
  };
}
