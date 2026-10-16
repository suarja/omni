// Summarize's model step (Brief 35a): one short sentence describing a session's Task-card
// evidence, or a receipt's actions — the "Doing: …" line and (later) the receipt description.
// Input is a bounded list of deterministic evidence lines, never a raw transcript.

import { z } from "zod";

import type { Task } from "../provider";

const MAX_SENTENCE_CHARS = 200;
const MAX_LINES = 20;
const MAX_LINE_CHARS = 300;

export type SummarizeKind = "session" | "receipt";

export type SummarizeInput = Readonly<{ kind: SummarizeKind; lines: readonly string[] }>;

const summarizeOutputSchema = z.object({ sentence: z.string().min(1).max(MAX_SENTENCE_CHARS) });

export type SummarizeOutput = z.infer<typeof summarizeOutputSchema>;

const SYSTEM = [
  "You summarize a coding agent session or a receipt of applied changes in one short, factual",
  "sentence — what is being done, not how you decided. Do not explain your reasoning process;",
  "reply with the requested JSON only.",
].join(" ");

export const summarizeTask: Task<SummarizeInput, SummarizeOutput> = {
  id: "summarize",
  categories: ["transcripts", "process-commands"],
  maxInputChars: MAX_LINES * (MAX_LINE_CHARS + 1) + 100,
  system: SYSTEM,
  schema: summarizeOutputSchema,
  buildInput(input) {
    const lines = input.lines.slice(0, MAX_LINES).map((line) => line.slice(0, MAX_LINE_CHARS));
    return [`Kind: ${input.kind}`, "", ...lines].join("\n");
  },
};
