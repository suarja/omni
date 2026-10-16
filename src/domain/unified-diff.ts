export type UnifiedDiff = Readonly<{ kind: "unified"; text: string; truncated: boolean }>;

type DiffLine = Readonly<{ kind: "context" | "add" | "remove"; text: string }>;

function asText(value: string | Uint8Array): string | undefined {
  if (typeof value === "string") return value;
  if (value.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

function lines(value: string): string[] {
  const result = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (result.at(-1) === "") result.pop();
  return result;
}

function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const table = Array.from({ length: before.length + 1 }, () => Array<number>(after.length + 1).fill(0));
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex]![afterIndex] =
        before[beforeIndex] === after[afterIndex]
          ? table[beforeIndex + 1]![afterIndex + 1]! + 1
          : Math.max(table[beforeIndex + 1]![afterIndex]!, table[beforeIndex]![afterIndex + 1]!);
    }
  }
  const result: DiffLine[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length || afterIndex < after.length) {
    if (beforeIndex < before.length && afterIndex < after.length && before[beforeIndex] === after[afterIndex]) {
      result.push({ kind: "context", text: before[beforeIndex]! });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      afterIndex < after.length &&
      (beforeIndex === before.length || table[beforeIndex]![afterIndex + 1]! > table[beforeIndex + 1]![afterIndex]!)
    ) {
      result.push({ kind: "add", text: after[afterIndex]! });
      afterIndex += 1;
    } else {
      result.push({ kind: "remove", text: before[beforeIndex]! });
      beforeIndex += 1;
    }
  }
  return result;
}

function truncateUtf8(value: string, maxBytes: number): Readonly<{ text: string; truncated: boolean }> {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return { text: value, truncated: false };
  let text = value;
  while (text && encoder.encode(text).byteLength > maxBytes) text = text.slice(0, -1);
  return { text, truncated: true };
}

const CONTEXT_LINES = 3;

type Hunk = Readonly<{
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  body: string;
}>;

/** Groups changed lines into hunks with three lines of context, as `diff -u` does. */
function hunks(diff: readonly DiffLine[]): Hunk[] {
  const changed = diff.map((line) => line.kind !== "context");
  const result: Hunk[] = [];
  let index = 0;
  while (index < diff.length) {
    if (!changed[index]) {
      index += 1;
      continue;
    }
    const start = Math.max(0, index - CONTEXT_LINES);
    let end = index;
    let lastChange = index;
    while (end < diff.length && end - lastChange <= CONTEXT_LINES * 2) {
      if (changed[end]) lastChange = end;
      end += 1;
    }
    end = Math.min(diff.length, lastChange + CONTEXT_LINES + 1);
    let beforeStart = 0;
    let afterStart = 0;
    for (let cursor = 0; cursor < start; cursor += 1) {
      if (diff[cursor]!.kind !== "add") beforeStart += 1;
      if (diff[cursor]!.kind !== "remove") afterStart += 1;
    }
    const slice = diff.slice(start, end);
    result.push({
      beforeStart: beforeStart + 1,
      beforeCount: slice.filter((line) => line.kind !== "add").length,
      afterStart: afterStart + 1,
      afterCount: slice.filter((line) => line.kind !== "remove").length,
      body: slice
        .map((line) => `${line.kind === "context" ? " " : line.kind === "add" ? "+" : "-"}${line.text}\n`)
        .join(""),
    });
    index = end;
  }
  return result;
}

export function createUnifiedDiff(
  beforeLabel: string,
  afterLabel: string,
  before: string | Uint8Array,
  after: string | Uint8Array,
  maxBytes = 64 * 1024,
): UnifiedDiff {
  const beforeText = asText(before);
  const afterText = asText(after);
  if (beforeText === undefined || afterText === undefined)
    return { kind: "unified", text: "binary file differs", truncated: false };
  const body = hunks(diffLines(lines(beforeText), lines(afterText)))
    .map(
      (hunk) => `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@\n${hunk.body}`,
    )
    .join("");
  const rendered = `--- ${beforeLabel}\n+++ ${afterLabel}\n${body}`;
  const truncated = truncateUtf8(rendered, maxBytes);
  return { kind: "unified", text: truncated.text, truncated: truncated.truncated };
}
