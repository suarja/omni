// Explain's model step (Brief 35a): say what differs between the two sides of a finding (a
// duplicate, a variant, a drift) and which to keep — a short, factual sentence, no chain of
// thought. Each side is a plain text excerpt, bounded independently so one long side never
// starves the other's budget.

import { z } from "zod";

import type { Task } from "../provider";

const MAX_SIDE_CHARS = 4_000;
const MAX_EXPLANATION_CHARS = 400;

export type ExplainInput = Readonly<{ findingKind: string; left: string; right: string }>;

const explainOutputSchema = z.object({
  explanation: z.string().min(1).max(MAX_EXPLANATION_CHARS),
  keep: z.enum(["left", "right", "either", "unknown"]),
});

export type ExplainOutput = z.infer<typeof explainOutputSchema>;

const SYSTEM = [
  "You explain what differs between two versions of the same skill or finding, in one short,",
  "factual sentence. Say which side to keep — left, right, either (both are fine), or unknown",
  "(you cannot tell from what is given). Do not explain your reasoning process; reply with the",
  "requested JSON only.",
].join(" ");

export const explainTask: Task<ExplainInput, ExplainOutput> = {
  id: "explain",
  categories: ["marketplace-content"],
  maxInputChars: MAX_SIDE_CHARS * 2 + 200,
  system: SYSTEM,
  schema: explainOutputSchema,
  buildInput(input) {
    const left = input.left.slice(0, MAX_SIDE_CHARS);
    const right = input.right.slice(0, MAX_SIDE_CHARS);
    return [`Finding kind: ${input.findingKind}`, "", "--- Left ---", left, "", "--- Right ---", right].join("\n");
  },
};
