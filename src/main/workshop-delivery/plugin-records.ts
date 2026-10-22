import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { githubRepository } from "../../domain/storefront-origin";
import { optionalText } from "../storefronts/files";
import { tomlHeaders } from "../mcp-entry";

export type PluginRecord = Readonly<{
  name: string;
  marketplace: string;
  version?: string;
  commit?: string;
  scope?: "user" | "project" | "local" | "managed";
  projectPath?: string;
}>;
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export function assertPluginName(value: unknown): string {
  if (typeof value !== "string" || !safeName.test(value)) throw new Error("Plugin or marketplace name is unsupported.");
  return value;
}
export function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin record is malformed.");
  return value as Record<string, unknown>;
}
export async function readHomeText(home: string, path: string): Promise<string | undefined> {
  return optionalText(createLocalInventoryPort(home, { maxFileBytes: 4 * 1024 * 1024 }), path);
}
function sameRepository(value: unknown, repository: string): boolean {
  return typeof value === "string" && githubRepository(value)?.toLowerCase() === repository.toLowerCase();
}
export async function readClaudePluginRecords(home: string, repository: string): Promise<readonly PluginRecord[]> {
  const known = await readHomeText(home, ".claude/plugins/known_marketplaces.json");
  if (known === undefined) return [];
  const marketplaces = Object.entries(jsonRecord(JSON.parse(known))).flatMap(([name, value]) => {
    const source = jsonRecord(jsonRecord(value).source);
    return (source.source === "github" && sameRepository(source.repo, repository)) ||
      (source.source === "git" && sameRepository(source.url, repository))
      ? [assertPluginName(name)]
      : [];
  });
  const text = await readHomeText(home, ".claude/plugins/installed_plugins.json");
  if (text === undefined) return [];
  const installed = jsonRecord(JSON.parse(text));
  if (installed.version !== 2) throw new Error("Claude Code plugin index version is unsupported.");
  const records: PluginRecord[] = [];
  for (const [id, entries] of Object.entries(jsonRecord(installed.plugins))) {
    const [name, marketplace, extra] = id.split("@");
    if (!marketplace || !marketplaces.includes(marketplace)) continue;
    if (extra || !Array.isArray(entries)) throw new Error("Claude Code plugin installation is malformed.");
    assertPluginName(name);
    for (const entry of entries) {
      const row = jsonRecord(entry);
      if (!["user", "project", "local", "managed"].includes(String(row.scope)))
        throw new Error("Claude Code plugin scope is unsupported.");
      const scope = row.scope as NonNullable<PluginRecord["scope"]>;
      if (
        (scope === "project" || scope === "local") &&
        (typeof row.projectPath !== "string" || !row.projectPath.startsWith("/"))
      )
        throw new Error("Claude Code project plugin has no exact project scope.");
      records.push({
        name: name!,
        marketplace,
        scope,
        ...(typeof row.projectPath === "string" ? { projectPath: row.projectPath } : {}),
        ...(typeof row.version === "string" ? { version: row.version } : {}),
        ...(typeof row.gitCommitSha === "string" && /^[a-f0-9]{40,64}$/u.test(row.gitCommitSha)
          ? { commit: row.gitCommitSha }
          : {}),
      });
    }
  }
  if (records.length > 10000) throw new Error("Claude Code plugin index exceeds the entry limit.");
  return records;
}

/** Read only the provider's simple marketplace/plugin tables; unsupported forms remain unknown. */
export function parseCodexPluginRecords(text: string, repository: string): readonly PluginRecord[] {
  const headers = tomlHeaders(text);
  const marketplaces = new Set<string>();
  const plugins: Array<{ name: string; marketplace: string }> = [];
  const seen = new Set<string>();
  for (const [index, header] of headers.entries()) {
    if (!/^(?:marketplaces|plugins)\./u.test(header.name)) continue;
    const match = /^(marketplaces|plugins)\.("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)$/u.exec(header.name);
    if (!match || seen.has(header.name)) throw new Error("Codex plugin table is unsupported or duplicated.");
    seen.add(header.name);
    const name = match[2]!.startsWith('"') ? (JSON.parse(match[2]!) as string) : match[2]!;
    const values = new Map<string, unknown>();
    for (const line of text.slice(header.end, headers[index + 1]?.start).split(/\r?\n/u)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const field = /^\s*([A-Za-z0-9_]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|true|false)\s*(?:#.*)?$/u.exec(line);
      if (!field || values.has(field[1]!)) throw new Error("Codex plugin setting is unsupported or duplicated.");
      const raw = field[2]!;
      values.set(field[1]!, raw.startsWith("'") ? raw.slice(1, -1) : JSON.parse(raw));
    }
    if (match[1] === "marketplaces") {
      if (values.get("source_type") === "git" && sameRepository(values.get("source"), repository))
        marketplaces.add(assertPluginName(name));
    } else {
      const [plugin, marketplace, extra] = name.split("@");
      if (!plugin || !marketplace || extra || typeof values.get("enabled") !== "boolean")
        throw new Error("Codex plugin selection is malformed.");
      plugins.push({ name: assertPluginName(plugin), marketplace: assertPluginName(marketplace) });
    }
  }
  return plugins.filter((plugin) => marketplaces.has(plugin.marketplace));
}
