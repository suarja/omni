import { isDeepStrictEqual } from "node:util";

import type { AgentHarness } from "../shared/agents-ipc";

type ClaudeMcpEntry = Readonly<{
  type: "stdio";
  command: "node";
  args: readonly [string];
  env: Readonly<{ OMNI_USER_DATA: string }>;
}>;

export type McpEntryState = Readonly<{ registered: boolean; current: boolean }>;

/**
 * Detects an existing JSON settings file's indent (spaces or tabs) and trailing-newline
 * convention and re-serializes `value` the same way, so an install that edits one key and a
 * later restore that reverses it reproduce the file byte-for-byte instead of normalizing every
 * provider settings file to "2 spaces, no trailing newline". A brand-new file (no `content`)
 * gets the one sane default: 2-space indent, trailing newline. Shared by the guard's hook-entry
 * writer (hook-entry.ts) and Claude's MCP-entry writer below — neither keeps its own copy.
 */
export function writeJsonPreservingFormat(content: string | undefined, value: unknown): string {
  if (content === undefined) return `${JSON.stringify(value, null, 2)}\n`;
  const indentMatch = /\n(\t+|[ ]+)["{[]/.exec(content);
  const indent = indentMatch ? (indentMatch[1]!.includes("\t") ? "\t" : indentMatch[1]!.length) : 2;
  const text = JSON.stringify(value, null, indent);
  return content.endsWith("\n") ? `${text}\n` : text;
}

export function mcpEntry(cliPath: string, userDataPath: string): ClaudeMcpEntry {
  return { type: "stdio", command: "node", args: [cliPath], env: { OMNI_USER_DATA: userDataPath } };
}

export function codexMcpBlock(cliPath: string, userDataPath: string): string {
  return `[mcp_servers.omni]\ncommand = "node"\nargs = [ "${cliPath}" ]\n\n[mcp_servers.omni.env]\nOMNI_USER_DATA = ${JSON.stringify(userDataPath)}\n`;
}

export type TomlHeader = Readonly<{ name: string; start: number; end: number }>;

export function tomlHeaders(content: string): readonly TomlHeader[] {
  const headers: TomlHeader[] = [];
  const expression = /^\[([^\]\r\n]+)\][^\r\n]*(?:\r\n|\n|$)/gm;
  for (const match of content.matchAll(expression)) {
    const start = match.index ?? 0;
    headers.push({ name: match[1]!, start, end: start + match[0].length });
  }
  return headers;
}

function omniHeader(header: TomlHeader): boolean {
  return header.name === "mcp_servers.omni" || header.name.startsWith("mcp_servers.omni.");
}

/** The `[mcp_servers.omni]` table with its sub-tables, as a span of the TOML text. */
export function codexSection(content: string): Readonly<{ section?: string; start?: number; end?: number }> {
  const headers = tomlHeaders(content);
  const index = headers.findIndex((header) => header.name === "mcp_servers.omni");
  if (index < 0) return {};
  const header = headers[index]!;
  const next = headers.find((candidate, candidateIndex) => candidateIndex > index && !omniHeader(candidate));
  return {
    section: content.slice(header.start, next?.start ?? content.length),
    start: header.start,
    end: next?.start ?? content.length,
  };
}

export function mcpEntryState(
  harness: AgentHarness,
  content: string | undefined,
  cliPath: string,
  userDataPath: string,
): McpEntryState {
  if (content === undefined) return { registered: false, current: false };
  try {
    if (harness === "claude-code") {
      const root = JSON.parse(content) as Record<string, unknown>;
      const servers = root.mcpServers;
      if (typeof servers !== "object" || servers === null || Array.isArray(servers))
        return { registered: false, current: false };
      const serverMap = servers as Record<string, unknown>;
      const registered = Object.prototype.hasOwnProperty.call(serverMap, "omni");
      return { registered, current: registered && isDeepStrictEqual(serverMap.omni, mcpEntry(cliPath, userDataPath)) };
    }
    const section = codexSection(content).section;
    return {
      registered: section !== undefined,
      current: section !== undefined && section.trim() === codexMcpBlock(cliPath, userDataPath).trim(),
    };
  } catch {
    return { registered: false, current: false };
  }
}

/**
 * The raw value of Claude Code's `mcpServers.omni` entry, exactly as found — not necessarily
 * the canonical value `mcpEntry()` builds. Used by restore to read what a backup held before an
 * install *updated* an already-registered entry, so it can be put back verbatim.
 */
export function readClaudeMcpEntryRaw(content: string | undefined): unknown {
  if (content === undefined) return undefined;
  try {
    const root = JSON.parse(content) as Record<string, unknown>;
    const servers = root.mcpServers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return undefined;
    const serverMap = servers as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(serverMap, "omni") ? serverMap.omni : undefined;
  } catch {
    return undefined;
  }
}

/** Sets (or removes, when `value` is undefined) `mcpServers.omni` in Claude Code settings content. */
export function setClaudeMcpEntryRaw(content: string | undefined, value: unknown): string | undefined {
  if (content === undefined) {
    if (value === undefined) return undefined;
    return writeJsonPreservingFormat(undefined, { mcpServers: { omni: value } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Claude Code settings are not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Claude Code settings must be a JSON object.");
  const root = parsed as Record<string, unknown>;
  const next = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
  const servers = (
    typeof next.mcpServers === "object" && next.mcpServers !== null && !Array.isArray(next.mcpServers)
      ? next.mcpServers
      : {}
  ) as Record<string, unknown>;
  if (value === undefined) delete servers.omni;
  else servers.omni = value;
  next.mcpServers = servers;
  return writeJsonPreservingFormat(content, next);
}

/**
 * Replaces (or removes, or inserts) the `[mcp_servers.omni]` table span with `block` — the same
 * positional insertion heuristic `operations-register-mcp.ts`'s `updateCodex` uses when the
 * table is not present yet, reused here so restore's "put the previous Codex entry back" does
 * not duplicate it.
 */
export function setCodexSectionRaw(content: string | undefined, block: string | undefined): string | undefined {
  if (content === undefined) return block;
  const existing = codexSection(content);
  if (block === undefined)
    return existing.start === undefined ? content : content.slice(0, existing.start) + content.slice(existing.end!);
  if (existing.start !== undefined) return content.slice(0, existing.start) + block + content.slice(existing.end!);
  const headers = tomlHeaders(content);
  const lastMcp = headers.filter((header) => header.name.startsWith("mcp_servers.")).at(-1);
  const insertion = lastMcp ? (headers[headers.indexOf(lastMcp) + 1]?.start ?? content.length) : content.length;
  const prefix = content.slice(0, insertion);
  const separator = !prefix ? "" : prefix.endsWith("\n\n") ? "" : prefix.endsWith("\n") ? "\n" : "\n\n";
  const rest = content.slice(insertion);
  const trailing = rest && !rest.startsWith("\n") ? "\n" : "";
  return `${prefix}${separator}${block}${trailing}${rest}`;
}
