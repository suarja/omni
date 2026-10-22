import { createHash } from "node:crypto";
import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { readCommittedFile, readBaseFiles } from "../git-read";
import { readPluginHashes } from "../storefronts/files";
import type {
  InstalledWorkshopPlugin,
  WorkshopDeliveryStatus,
  PluginUpdateCommand,
} from "../../shared/workshop-delivery-ipc";
import {
  assertPluginName,
  jsonRecord,
  parseCodexPluginRecords,
  readClaudePluginRecords,
  readHomeText,
  type PluginRecord,
} from "./plugin-records";

type Options = Readonly<{ home: string; workshop: string; repository?: string; pushedCommit?: string }>;
type PublishedPlugin = Readonly<{ folder: string; version?: string }>;
async function readPublishedPlugin(
  options: Options,
  harness: InstalledWorkshopPlugin["harness"],
  name: string,
): Promise<PublishedPlugin | undefined> {
  if (!options.pushedCommit) return undefined;
  const catalogue = await readCommittedFile(
    options.workshop,
    options.pushedCommit,
    harness === "claude-code" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json",
  );
  if (!catalogue) return undefined;
  const entries = jsonRecord(JSON.parse(Buffer.from(catalogue).toString("utf8"))).plugins;
  if (!Array.isArray(entries)) throw new Error("Pushed marketplace plugin list is malformed.");
  const entry = entries.map(jsonRecord).find((entry) => entry.name === name);
  if (!entry) return undefined;
  const source = entry.source;
  const folder =
    typeof source === "string"
      ? source.replace(/^\.\//u, "")
      : source &&
          typeof source === "object" &&
          !Array.isArray(source) &&
          "source" in source &&
          source.source === "local" &&
          "path" in source &&
          typeof source.path === "string"
        ? source.path.replace(/^\.\//u, "")
        : undefined;
  if (!folder || folder.startsWith("/") || folder.split("/").some((part) => !part || part === ".." || part === "."))
    return undefined;
  const manifest = await readCommittedFile(
    options.workshop,
    options.pushedCommit,
    `${folder}/.${harness === "codex" ? "codex" : "claude"}-plugin/plugin.json`,
  );
  const version = manifest && jsonRecord(JSON.parse(Buffer.from(manifest).toString("utf8"))).version;
  return { folder, ...(typeof version === "string" ? { version } : {}) };
}
function updateCommands(record: PluginRecord, harness: InstalledWorkshopPlugin["harness"]): PluginUpdateCommand[] {
  if (record.scope === "managed") return [];
  return harness === "claude-code"
    ? [
        { executable: "claude", args: ["plugin", "marketplace", "update", record.marketplace, "--json"] },
        {
          executable: "claude",
          args: [
            "plugin",
            "update",
            `${record.name}@${record.marketplace}`,
            "--scope",
            record.scope ?? "user",
            "--json",
          ],
          ...(record.projectPath ? { cwd: record.projectPath } : {}),
        },
      ]
    : [
        { executable: "codex", args: ["plugin", "marketplace", "upgrade", record.marketplace, "--json"] },
        { executable: "codex", args: ["plugin", "add", `${record.name}@${record.marketplace}`, "--json"] },
      ];
}
async function codexVersion(home: string, record: PluginRecord): Promise<string | undefined> {
  const filesystem = createLocalInventoryPort(home);
  const path = `.codex/plugins/cache/${record.marketplace}/${record.name}`;
  let entries;
  try {
    entries = await filesystem.listDirectory(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "not-found") return undefined;
    throw error;
  }
  const versions = entries.filter((entry) => entry.type === "directory");
  if (versions.length !== 1) return undefined;
  const version = assertPluginName(versions[0]!.name);
  const manifest = await readHomeText(home, `${path}/${version}/.codex-plugin/plugin.json`);
  if (!manifest || jsonRecord(JSON.parse(manifest)).version !== version) return undefined;
  return version;
}
async function sameCodexFiles(options: Options, record: PluginRecord, published: PublishedPlugin): Promise<boolean> {
  if (!options.pushedCommit || !record.version) return false;
  const files = await readBaseFiles(options.workshop, options.pushedCommit, published.folder);
  if (!files) return false;
  const expected = Object.fromEntries(
    Object.entries(files)
      .filter(([path]) => path !== "omni.plugin.json")
      .map(([path, bytes]) => [path, createHash("sha256").update(bytes).digest("hex")]),
  );
  const actual = await readPluginHashes(
    options.home,
    `.codex/plugins/cache/${record.marketplace}/${record.name}/${record.version}`,
  );
  return (
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([path, hash]) => actual[path] === hash)
  );
}
async function comparePlugin(
  options: Options,
  record: PluginRecord,
  harness: InstalledWorkshopPlugin["harness"],
): Promise<InstalledWorkshopPlugin> {
  let state: InstalledWorkshopPlugin["state"] = "unknown",
    diagnostic: string | undefined;
  const version = harness === "codex" ? await codexVersion(options.home, record) : record.version;
  record = { ...record, ...(version ? { version } : {}) };
  const published = await readPublishedPlugin(options, harness, record.name);
  if (!published || !options.pushedCommit)
    diagnostic = "The pushed plugin revision is unavailable. Push the workshop and check again.";
  else if (harness === "claude-code" && record.commit)
    state = record.commit === options.pushedCommit ? "current" : "behind";
  else if (version && published.version && version !== published.version) state = "behind";
  else if (harness === "codex" && version)
    state = (await sameCodexFiles(options, record, published)) ? "current" : "behind";
  else
    diagnostic =
      "The installed plugin revision cannot be confirmed. Inspect the provider records and update explicitly.";
  if (record.scope === "managed")
    diagnostic = "This installation is managed by policy. Ask its administrator to update it.";
  return {
    ...record,
    harness,
    state,
    commands: updateCommands(record, harness),
    ...(published?.version ? { expectedVersion: published.version } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}
export async function readInstalledWorkshopPlugins(options: Options): Promise<WorkshopDeliveryStatus["plugins"]> {
  const installations: InstalledWorkshopPlugin[] = [],
    diagnostics: string[] = [];
  if (!options.repository)
    return {
      status: "unavailable",
      behind: 0,
      installations,
      diagnostics: ["The workshop has no identifiable GitHub repository. Installed plugins cannot be matched."],
    };
  for (const harness of ["claude-code", "codex"] as const) {
    try {
      const records =
        harness === "claude-code"
          ? await readClaudePluginRecords(options.home, options.repository)
          : parseCodexPluginRecords((await readHomeText(options.home, ".codex/config.toml")) ?? "", options.repository);
      for (const record of records) {
        try {
          installations.push(await comparePlugin(options, record, harness));
        } catch {
          installations.push({
            ...record,
            harness,
            state: "unknown",
            commands: [],
            diagnostic: "The plugin cache or pushed manifest could not be read safely. Repair access and check again.",
          });
        }
      }
    } catch {
      diagnostics.push(
        `${harness} plugin records could not be read safely. Repair the provider index and check again.`,
      );
    }
  }
  return {
    status:
      diagnostics.length === 2
        ? "unavailable"
        : diagnostics.length || installations.some((plugin) => plugin.state === "unknown")
          ? "partial"
          : "ready",
    behind: installations.filter((plugin) => plugin.state === "behind").length,
    installations,
    diagnostics,
  };
}
