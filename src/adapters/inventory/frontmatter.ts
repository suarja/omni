export type FrontmatterResult = Readonly<{ valid: boolean; name?: string; description?: string }>;

function unquote(value: string): string {
  const quoted = value.match(/^(["'])(.*)\1$/);
  if (!quoted) return value;
  // A double-quoted YAML scalar uses JSON-style escapes; a single-quoted one only doubles quotes.
  if (quoted[1] === '"') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through to the raw content
    }
    return quoted[2] ?? "";
  }
  return (quoted[2] ?? "").replaceAll("''", "'");
}

export function parseFrontmatter(text: string, required: boolean): FrontmatterResult {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { valid: !required };

  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closingIndex < 0) return { valid: false };

  let name: string | undefined;
  let description: string | undefined;
  let descriptionBlock = false;
  for (const line of lines.slice(1, closingIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("- ")) continue;
    const field = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (field && !(descriptionBlock && /^\s+/.test(line))) {
      const value = field[2].trim();
      descriptionBlock = field[1] === "description" && /^[>|][+-]?$/.test(value);
      if (field[1] === "description" && value && !descriptionBlock) description = unquote(value);
      if (field[1] === "name" && value) name = unquote(value);
      continue;
    }
    if (/^\s+/.test(line)) {
      if (descriptionBlock && !description) description = trimmed;
      continue;
    }
    return { valid: false };
  }

  return { valid: true, ...(name ? { name } : {}), ...(description ? { description } : {}) };
}
