// Helpers shared by the harness evidence adapters: JSON-lines parsing, safe text, timestamps,
// and the display form of paths (home shown as "~"). Pure; no file access.

export type RecordValue = Record<string, unknown>;

export function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

export function parseJsonLines(text: string): RecordValue[] {
  return text.split(/\r?\n/u).flatMap((line) => {
    try {
      const item = record(JSON.parse(line));
      return item ? [item] : [];
    } catch {
      return [];
    }
  });
}

export function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").trim();
  return result || undefined;
}

// Accepts epoch milliseconds, epoch seconds (Codex `started_at`), or an ISO string.
export function safeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string") return undefined;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

// A full prompt snippet, as opposed to `safeText` (control characters only): newlines and tabs
// collapse to a single space so multi-line input reads as one paragraph, then the result is
// bounded to `maxChars`. Used for the activity fields, which show the full prompt (up to the
// limit) rather than only its first line.
export function textSnippet(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutNewlines = value.replace(/[\n\r\t]/gu, " ");
  const cleaned = safeText(withoutNewlines);
  if (!cleaned) return undefined;
  const collapsed = cleaned.replace(/ {2,}/gu, " ");
  return collapsed.slice(0, maxChars);
}

// The target of a `tool_use` block: the file path (Read/Edit/Write), else the command's first
// 120 characters (Bash), else the search pattern (Grep/Glob). Undefined when none is present
// (e.g. Agent/Task, whose input carries a description and prompt instead).
export function toolTarget(input: RecordValue | undefined): string | undefined {
  if (!input) return undefined;
  const filePath = safeText(input.file_path);
  if (filePath) return filePath;
  const command = safeText(input.command);
  if (command) return command.slice(0, 120);
  return safeText(input.pattern);
}

export function executableName(command: string): string {
  return (command.trim().split(/\s+/u)[0] ?? "").split("/").at(-1) ?? "";
}

export function displayPath(path: string, homeDir: string): string {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedHome = homeDir.replaceAll("\\", "/").replace(/\/$/u, "");
  if (normalizedPath === normalizedHome) return "~";
  return normalizedPath.startsWith(`${normalizedHome}/`)
    ? `~${normalizedPath.slice(normalizedHome.length)}`
    : normalizedPath;
}
