import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type ContextSection = Readonly<{
  name: string;
  content: string;
  priority: number;
  itemCount?: number;
}>;
export type BudgetedContext = Readonly<{
  prompt: string;
  estimate: number;
  sections: readonly ContextSection[];
}>;

const BUDGET_RATIO = 0.6;
const MAX_READ_FILE_BYTES = 64 * 1024;

/** The same byte-based estimate is used for calls, sections, tool results, and job reporting. */
export function estimateTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

export function calculateContextBudget(contextWindow: number, maxOutputTokensPerTurn: number): number {
  return Math.max(0, Math.floor(contextWindow * BUDGET_RATIO) - maxOutputTokensPerTurn);
}

export function maxTokensPerTurn(model: Readonly<{ maxOutputTokens?: number }>): number {
  return Math.min(4_096, model.maxOutputTokens ?? 4_096);
}

export function readFileByteLimit(budgetTokens: number): number {
  return Math.max(1, Math.min(MAX_READ_FILE_BYTES, Math.floor(budgetTokens * 0.1 * 4)));
}

export function formatContextTokens(tokens: number): string {
  return `${Math.round(tokens / 1_000)} k`;
}

export function formatContextUsage(estimate: number, contextWindow: number): string {
  return `~${formatContextTokens(estimate)} / ${formatContextTokens(contextWindow)}`;
}

function prefixByBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8");
}

function prefixWithNotice(value: string, notice: string, tokenLimit: number): string {
  const availableBytes = Math.min(Buffer.byteLength(value, "utf8"), Math.max(0, tokenLimit * 4));
  let low = 0;
  let high = availableBytes;
  while (low < high) {
    const candidateBytes = Math.ceil((low + high) / 2);
    const candidate = `${prefixByBytes(value, candidateBytes)}${notice}`;
    if (estimateTokens(candidate) <= tokenLimit) low = candidateBytes;
    else high = candidateBytes - 1;
  }
  return `${prefixByBytes(value, low)}${notice}`;
}

function truncateSection(section: ContextSection, tokenLimit: number): ContextSection {
  if (estimateTokens(section.content) <= tokenLimit) return section;
  const originalBytes = Buffer.byteLength(section.content, "utf8");
  const maxBytes = Math.max(0, tokenLimit * 4);
  const keptItems =
    section.itemCount === undefined
      ? undefined
      : Math.min(
          section.itemCount,
          Math.max(0, Math.floor((maxBytes / Math.max(originalBytes, 1)) * section.itemCount)),
        );
  const notice =
    section.itemCount === undefined
      ? `\n\n(section cut to ~${tokenLimit} tokens)`
      : `\n\n(list cut to ${keptItems ?? 0} of ${section.itemCount})`;
  return { ...section, content: prefixWithNotice(section.content, notice, tokenLimit) };
}

export function budgetSections(sections: readonly ContextSection[], budgetTokens: number): BudgetedContext {
  const headers = sections.map((section) => `## ${section.name}`).join("\n\n");
  let remainingTokens = Math.max(0, budgetTokens - estimateTokens(headers));
  let remainingWeight = sections.reduce((sum, section) => sum + Math.max(1, section.priority), 0);
  const result: ContextSection[] = [];
  for (const [index, section] of sections.entries()) {
    const weight = Math.max(1, section.priority);
    const share =
      index === sections.length - 1 ? remainingTokens : Math.floor((remainingTokens * weight) / remainingWeight);
    const bounded = truncateSection(section, share);
    result.push(bounded);
    remainingTokens = Math.max(0, remainingTokens - Math.min(share, estimateTokens(bounded.content)));
    remainingWeight = Math.max(1, remainingWeight - weight);
  }
  const prompt = result.map((section) => `## ${section.name}\n${section.content}`).join("\n\n");
  return { prompt, estimate: estimateTokens(prompt), sections: result };
}

export const buildBudgetedPrompt = budgetSections;

function messageRole(message: AgentMessage): string {
  return typeof message === "object" && message !== null && "role" in message ? String(message.role) : "";
}

function messageChars(message: AgentMessage): number {
  if (messageRole(message) !== "toolResult") return 0;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content.length : JSON.stringify(content ?? "").length;
}

function prunedToolResult(message: AgentMessage): AgentMessage {
  const record = message as unknown as Record<string, unknown>;
  const { details: _details, ...withoutDetails } = record;
  const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
  return {
    ...withoutDetails,
    content: [{ type: "text", text: `(result of ${toolName} pruned: ${messageChars(message)} chars)` }],
  } as AgentMessage;
}

export function pruneContext(
  messages: readonly AgentMessage[],
  budgetTokens: number,
  systemPrompt = "",
): readonly AgentMessage[] {
  const result = [...messages];
  const protectedIndexes = new Set<number>();
  result.forEach((message, index) => {
    if (messageRole(message) === "system") protectedIndexes.add(index);
  });
  const firstUser = result.findIndex((message) => messageRole(message) === "user");
  if (firstUser >= 0) protectedIndexes.add(firstUser);
  for (let index = Math.max(0, result.length - 6); index < result.length; index += 1) protectedIndexes.add(index);
  const estimate = (): number => estimateTokens(systemPrompt) + estimateTokens(JSON.stringify(result));
  if (estimate() <= budgetTokens) return result;
  for (let index = 0; index < result.length && estimate() > budgetTokens; index += 1) {
    if (protectedIndexes.has(index) || messageRole(result[index]!) !== "toolResult") continue;
    result[index] = prunedToolResult(result[index]!);
  }
  return result;
}

export function isContextExhausted(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { stopReason?: unknown; errorMessage?: unknown };
  if (record.stopReason === "length") return true;
  return (
    typeof record.errorMessage === "string" &&
    /context_length_exceeded|maximum context|\b413\b/i.test(record.errorMessage)
  );
}

export function contextExhaustionReason(estimate: number, contextWindow: number, turns: number): string {
  return `Context exhausted: ~${formatContextTokens(estimate)} tokens for a ${formatContextTokens(contextWindow)} window after ${turns} turns.`;
}
