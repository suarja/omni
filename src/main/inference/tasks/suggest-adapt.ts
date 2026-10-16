// Suggest's model step (Brief 35a): pick and adapt the top ranked catalogue candidates to a
// project's stack profile — never invent a candidate, never a chain of thought, one factual
// line each on why. `commands/suggest.ts` is the pipeline around this; the ranked candidates and
// the profile tags both come from the existing deterministic ranker (`catalogue/rank.ts`).

import { z } from "zod";

import type { Task } from "../provider";

const MAX_REASON_CHARS = 160;
const MAX_PICKS = 5;
const MAX_CANDIDATES = 8;

export type SuggestAdaptProfileTag = Readonly<{ id: string; label: string; evidenceCount: number }>;

export type SuggestAdaptCandidate = Readonly<{
  ownerRepo: string;
  skill: string;
  name: string;
  description?: string;
  why: readonly string[];
}>;

export type SuggestAdaptInput = Readonly<{
  profileTags: readonly SuggestAdaptProfileTag[];
  candidates: readonly SuggestAdaptCandidate[];
  /** The UI language the reasons are written in (default English). */
  language?: "en" | "fr";
}>;

const suggestAdaptOutputSchema = z.object({
  picks: z
    .array(
      z.object({
        skill: z.string().min(1),
        ownerRepo: z.string().min(1),
        reason: z.string().min(1).max(MAX_REASON_CHARS),
      }),
    )
    .max(MAX_PICKS),
});

export type SuggestAdaptOutput = z.infer<typeof suggestAdaptOutputSchema>;

const SYSTEM = [
  "You choose which of the given catalogue candidates fit this project and say why in one",
  "short, factual sentence each. Only pick from the candidates given to you — never invent a",
  "skill, owner, or repository. Pick at most five. Do not explain your reasoning process; reply",
  "with the requested JSON only.",
].join(" ");

function formatTag(tag: SuggestAdaptProfileTag): string {
  return `${tag.label} (${tag.id}, evidence: ${tag.evidenceCount})`;
}

function formatCandidate(candidate: SuggestAdaptCandidate, index: number): string {
  const lines = [
    `${index + 1}. ${candidate.name} — ${candidate.ownerRepo}/${candidate.skill}`,
    candidate.description ? `   description: ${candidate.description}` : undefined,
    candidate.why.length ? `   matches: ${candidate.why.join(", ")}` : undefined,
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

export const suggestAdaptTask: Task<SuggestAdaptInput, SuggestAdaptOutput> = {
  id: "suggest-adapt",
  categories: ["marketplace-content", "stack-files"],
  maxInputChars: 6_000,
  system: SYSTEM,
  schema: suggestAdaptOutputSchema,
  buildInput(input) {
    const candidates = input.candidates.slice(0, MAX_CANDIDATES);
    return [
      `Write every reason in ${input.language === "fr" ? "French" : "English"}.`,
      "",
      "Project stack tags:",
      input.profileTags.length ? input.profileTags.map(formatTag).join("\n") : "(none)",
      "",
      "Candidates (pick from these only):",
      candidates.map(formatCandidate).join("\n\n"),
    ].join("\n");
  },
};
