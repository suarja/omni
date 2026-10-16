import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_FEATURES,
  DEFAULT_GUARD_SETTINGS,
  DEFAULT_EXTERNAL_LIBRARY_SETTINGS,
  parseSettingsSetRequest,
  parseLoginDecision,
  type AiSettings,
  type Settings,
  type SettingsSetRequest,
} from "../shared/settings-ipc";
import { isMissing } from "./fs-optional";

export type SettingsUpdate = SettingsSetRequest;
export interface SettingsStore {
  read(): Promise<Settings>;
  set(update: SettingsUpdate): Promise<Settings>;
  recordAgentVersion(version: string): Promise<Settings>;
  recordLoginDecision(openAtLogin: boolean): Promise<Settings>;
}
const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 8,
  git: { commitChanges: true },
  agents: {
    approval: { personalMarketplace: "conversation", projects: "conversation" },
    guard: DEFAULT_GUARD_SETTINGS,
  },
  ai: DEFAULT_AI_SETTINGS,
  features: DEFAULT_FEATURES,
  externalLibrary: DEFAULT_EXTERNAL_LIBRARY_SETTINGS,
};
const storesByPath = new Map<string, SettingsStore>();

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Settings are invalid.");
  return value as Record<string, unknown>;
}
function legacyAi(value: unknown): AiSettings {
  if (value === undefined) return DEFAULT_AI_SETTINGS;
  const legacy = record(value);
  const provider = legacy.provider;
  if (typeof provider !== "string") throw new Error("Settings are invalid.");
  const connection =
    provider === "api-key" && legacy.apiKeyProvider === "anthropic"
      ? { preset: "anthropic" as const, displayName: "Anthropic" }
      : undefined;
  const categories = record(legacy.dataCategories);
  const commands = record(legacy.commands);
  if (
    !Object.values(categories).every((candidate) => typeof candidate === "boolean") ||
    !Object.values(commands).every((candidate) => typeof candidate === "boolean")
  )
    throw new Error("Settings are invalid.");
  return {
    ...(connection ? { connection } : {}),
    ...DEFAULT_AI_SETTINGS,
    dataCategories: {
      marketplaceContent: categories.marketplaceContent as boolean,
      stackFiles: categories.stackFiles as boolean,
      transcripts: categories.transcripts as boolean,
      processCommands: categories.processCommands as boolean,
    },
    commands: {
      suggest: commands.suggest as boolean,
      explain: commands.explain as boolean,
      summarize: commands.summarize as boolean,
    },
  };
}
function agents(value: unknown): Settings["agents"] {
  const valueRecord = record(value);
  const approval = record(valueRecord.approval);
  if (
    Object.keys(valueRecord).some((key) => key !== "approval") ||
    Object.keys(approval).some((key) => key !== "personalMarketplace" && key !== "projects") ||
    ![approval.personalMarketplace, approval.projects].every((mode) => mode === "conversation" || mode === "omni")
  )
    throw new Error("Settings are invalid.");
  return {
    approval: {
      personalMarketplace: approval.personalMarketplace as "conversation" | "omni",
      projects: approval.projects as "conversation" | "omni",
    },
    guard: DEFAULT_GUARD_SETTINGS,
  };
}
// v1–v5 agents payloads predate the guard switch (schemaVersion 6): default it before the
// strict v6 parse so every earlier settings file keeps migrating instead of failing to load.
function withDefaultGuard(value: unknown): unknown {
  const source = record(value);
  return { ...source, guard: source.guard ?? DEFAULT_GUARD_SETTINGS };
}
function migrate(value: unknown): Settings {
  const source = record(value);
  const git = record(source.git);
  if (typeof git.commitChanges !== "boolean") throw new Error("Settings are invalid.");
  if (source.schemaVersion === 1) return { ...DEFAULT_SETTINGS, git: { commitChanges: git.commitChanges } };
  // The legacy `agents()` parser only accepts the v2/v3 shape (no `guard`); calling it on a
  // v4+ payload that already carries `guard` would reject it, so it only ever runs here.
  if (source.schemaVersion === 2) {
    const currentAgents = agents(source.agents);
    return { ...DEFAULT_SETTINGS, git: { commitChanges: git.commitChanges }, agents: currentAgents };
  }
  if (source.schemaVersion === 3) {
    if (Object.keys(source).some((key) => !["schemaVersion", "git", "agents", "intelligence"].includes(key)))
      throw new Error("Settings are invalid.");
    return {
      schemaVersion: 8,
      git: { commitChanges: git.commitChanges },
      agents: agents(source.agents),
      ai: legacyAi(source.intelligence),
      features: DEFAULT_FEATURES,
      externalLibrary: DEFAULT_EXTERNAL_LIBRARY_SETTINGS,
    };
  }
  // Earlier versions default only the fields introduced after that version.
  if (![4, 5, 6, 7, 8].includes(source.schemaVersion as number)) throw new Error("Settings are invalid.");
  const allowedKeys =
    source.schemaVersion === 4
      ? ["schemaVersion", "git", "agents", "ai"]
      : [
          "schemaVersion",
          "git",
          "agents",
          "ai",
          "features",
          ...(Number(source.schemaVersion) >= 7 ? ["externalLibrary"] : []),
          ...(source.schemaVersion === 8 ? ["login"] : []),
        ];
  if (Object.keys(source).some((key) => !allowedKeys.includes(key))) throw new Error("Settings are invalid.");
  const parsed = parseSettingsSetRequest({
    commitChanges: git.commitChanges,
    agents: Number(source.schemaVersion) >= 6 ? source.agents : withDefaultGuard(source.agents),
    ai: source.ai,
    features: source.schemaVersion === 4 ? DEFAULT_FEATURES : source.features,
    externalLibrary: Number(source.schemaVersion) >= 7 ? source.externalLibrary : DEFAULT_EXTERNAL_LIBRARY_SETTINGS,
  });
  return {
    schemaVersion: 8,
    git: { commitChanges: parsed.commitChanges },
    agents: parsed.agents,
    ai: parsed.ai,
    features: parsed.features,
    externalLibrary: parsed.externalLibrary,
    ...(source.login === undefined ? {} : { login: parseLoginDecision(source.login) }),
  };
}
async function writeAtomically(filePath: string, settings: Settings): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
export function settingsFilePath(userDataPath: string): string {
  return join(resolve(userDataPath), "omni", "settings.json");
}
export function createSettingsStore(filePath: string): SettingsStore {
  const resolved = resolve(filePath);
  const existing = storesByPath.get(resolved);
  if (existing) return existing;
  let loaded: Settings | undefined;
  let queue = Promise.resolve();
  const read = async (): Promise<Settings> => {
    if (loaded) return loaded;
    try {
      loaded = migrate(JSON.parse(await readFile(resolved, "utf8")) as unknown);
    } catch (error: unknown) {
      if (!isMissing(error)) throw new Error("Settings are unavailable.");
      loaded = DEFAULT_SETTINGS;
    }
    return loaded;
  };
  const set = async (update: SettingsUpdate): Promise<Settings> => {
    const result = queue.then(async () => {
      const parsed = parseSettingsSetRequest(update);
      const current = await read();
      const next: Settings = {
        schemaVersion: 8,
        git: { commitChanges: parsed.commitChanges },
        agents: { ...parsed.agents, installedByVersion: current.agents.installedByVersion },
        ai: parsed.ai,
        features: parsed.features,
        externalLibrary: parsed.externalLibrary,
        ...(current.login ? { login: current.login } : {}),
      };
      await writeAtomically(`${resolved}.bak`, next);
      await writeAtomically(resolved, next);
      loaded = next;
      return next;
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const recordAgentVersion = (version: string): Promise<Settings> => {
    const result = queue.then(async () => {
      const current = await read();
      const next = { ...current, agents: { ...current.agents, installedByVersion: version } };
      parseSettingsSetRequest({
        commitChanges: next.git.commitChanges,
        agents: next.agents,
        ai: next.ai,
        features: next.features,
        externalLibrary: next.externalLibrary,
      });
      await writeAtomically(`${resolved}.bak`, next);
      await writeAtomically(resolved, next);
      loaded = next;
      return next;
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const recordLoginDecision = (openAtLogin: boolean): Promise<Settings> => {
    const result = queue.then(async () => {
      const next: Settings = { ...(await read()), login: parseLoginDecision({ openAtLogin }) };
      await writeAtomically(`${resolved}.bak`, next);
      await writeAtomically(resolved, next);
      loaded = next;
      return next;
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const store: SettingsStore = { read, set, recordAgentVersion, recordLoginDecision };
  storesByPath.set(resolved, store);
  return store;
}
