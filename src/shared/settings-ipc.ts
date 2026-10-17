import { AI_FUNCTION_IDS } from "./ai-gateway-ipc";
import type { Connection, FunctionRoutes } from "./ai-gateway-ipc";

export type ApprovalMode = "conversation" | "omni";
export type AiDataCategories = Readonly<{
  marketplaceContent: boolean;
  stackFiles: boolean;
  transcripts: boolean;
  processCommands: boolean;
}>;
export type AiCommands = Readonly<{ suggest: boolean; explain: boolean; summarize: boolean }>;
export type AiSettings = Readonly<{
  connection?: Connection;
  functions: FunctionRoutes;
  dataCategories: AiDataCategories;
  commands: AiCommands;
}>;
export type FeatureKey = "learn" | "compose" | "activityAgents" | "aiProviders";
export type FeatureFlags = Readonly<Record<FeatureKey, boolean>>;
export const FEATURE_KEYS: readonly FeatureKey[] = ["learn", "compose", "activityAgents", "aiProviders"];
export const DEFAULT_FEATURES: FeatureFlags = {
  learn: false,
  compose: false,
  activityAgents: false,
  aiProviders: false,
};
// The guard's per-project "warn only" switch (Brief B1, item 6): project ids the owner has
// opted into direct-write warnings for, instead of the default deny. Kept in settings (not
// guard.json, which is a derived, non-receipted projection of this plus the registry) so it
// survives like every other Omni preference and every settings writer must carry it through.
export type GuardSettings = Readonly<{ warnProjectIds: readonly string[] }>;
export const DEFAULT_GUARD_SETTINGS: GuardSettings = { warnProjectIds: [] };
export type ExternalLibrarySettings = Readonly<{ updates: "auto" | "ask" }>;
export const DEFAULT_EXTERNAL_LIBRARY_SETTINGS: ExternalLibrarySettings = { updates: "auto" };
export type Settings = Readonly<{
  schemaVersion: 8;
  workspaceSetupHidden?: boolean;
  login?: Readonly<{ openAtLogin: boolean }>;
  git: Readonly<{ commitChanges: boolean }>;
  agents: Readonly<{
    approval: Readonly<{ personalMarketplace: ApprovalMode; projects: ApprovalMode }>;
    guard: GuardSettings;
    installedByVersion?: string;
  }>;
  ai: AiSettings;
  features: FeatureFlags;
  externalLibrary: ExternalLibrarySettings;
}>;
export const SETTINGS_IPC_CHANNELS = { get: "omni:settings:get", set: "omni:settings:set" } as const;
export type SettingsSetRequest = Readonly<{
  workspaceSetupHidden?: boolean;
  commitChanges: boolean;
  agents: Readonly<{
    approval: Readonly<{ personalMarketplace: ApprovalMode; projects: ApprovalMode }>;
    guard: GuardSettings;
  }>;
  ai: AiSettings;
  features: FeatureFlags;
  externalLibrary: ExternalLibrarySettings;
}>;
export const DEFAULT_AI_SETTINGS: AiSettings = {
  functions: { "suggest-adapt": "auto", explain: "auto", summarize: "auto", compose: "auto" },
  dataCategories: { marketplaceContent: true, stackFiles: true, transcripts: false, processCommands: false },
  commands: { suggest: true, explain: true, summarize: true },
};

type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}
function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unexpected field.`);
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is invalid.`);
  return value;
}
function preset(value: unknown): Connection["preset"] {
  if (
    ![
      "anthropic",
      "openai",
      "openrouter",
      "vercel-ai-gateway",
      "groq",
      "mistral",
      "ollama",
      "lmstudio",
      "custom",
    ].includes(value as string)
  )
    throw new Error("AI preset is invalid.");
  return value as Connection["preset"];
}
function parseConnection(value: unknown): Connection | undefined {
  if (value === undefined) return undefined;
  const connection = record(value, "AI connection");
  keys(connection, ["preset", "baseUrl", "displayName"], "AI connection");
  return {
    preset: preset(connection.preset),
    ...(connection.baseUrl === undefined ? {} : { baseUrl: text(connection.baseUrl, "AI base URL") }),
    displayName: text(connection.displayName, "AI display name"),
  };
}
function parseDataCategories(value: unknown): AiDataCategories {
  const categories = record(value, "AI data categories");
  keys(categories, ["marketplaceContent", "stackFiles", "transcripts", "processCommands"], "AI data categories");
  if (!Object.values(categories).every((candidate) => typeof candidate === "boolean"))
    throw new Error("AI data categories must be booleans.");
  return categories as AiDataCategories;
}
function parseCommands(value: unknown): AiCommands {
  const commands = record(value, "AI commands");
  keys(commands, ["suggest", "explain", "summarize"], "AI commands");
  if (!Object.values(commands).every((candidate) => typeof candidate === "boolean"))
    throw new Error("AI commands must be booleans.");
  return commands as AiCommands;
}
function id(value: unknown, label: string): string {
  const result = text(value, label).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(result)) throw new Error(`${label} is malformed.`);
  return result;
}
function parseFunctions(value: unknown): FunctionRoutes {
  const functions = record(value, "AI functions");
  keys(functions, AI_FUNCTION_IDS, "AI functions");
  const result = {} as Record<keyof FunctionRoutes, "auto" | { modelId: string }>;
  for (const task of AI_FUNCTION_IDS) {
    const route = functions[task] ?? "auto";
    if (route === "auto") result[task] = route;
    else {
      const explicit = record(route, `AI function ${task}`);
      keys(explicit, ["modelId"], `AI function ${task}`);
      result[task] = { modelId: id(explicit.modelId, `AI function ${task} model id`) };
    }
  }
  return result;
}
function parseAi(value: unknown): AiSettings {
  const ai = record(value, "AI settings");
  keys(ai, ["connection", "functions", "dataCategories", "commands"], "AI settings");
  const connection = parseConnection(ai.connection);
  return {
    ...(connection ? { connection } : {}),
    functions: parseFunctions(ai.functions),
    dataCategories: parseDataCategories(ai.dataCategories),
    commands: parseCommands(ai.commands),
  };
}
function parseFeatures(value: unknown): FeatureFlags {
  const features = record(value, "Settings features");
  keys(features, FEATURE_KEYS, "Settings features");
  if (!FEATURE_KEYS.every((key) => typeof features[key] === "boolean"))
    throw new Error("Settings features must be booleans.");
  return features as FeatureFlags;
}
function parseGuard(value: unknown): GuardSettings {
  const guard = record(value, "Settings guard");
  keys(guard, ["warnProjectIds"], "Settings guard");
  if (!Array.isArray(guard.warnProjectIds)) throw new Error("Settings guard warn project ids must be an array.");
  const warnProjectIds = guard.warnProjectIds.map((item) => id(item, "Settings guard warn project id"));
  if (new Set(warnProjectIds).size !== warnProjectIds.length)
    throw new Error("Settings guard warn project ids must be unique.");
  return { warnProjectIds };
}
function parseAgents(value: unknown): Settings["agents"] {
  const agents = record(value, "Settings agents");
  keys(agents, ["approval", "guard", "installedByVersion"], "Settings agents");
  const approval = record(agents.approval, "Settings approval");
  keys(approval, ["personalMarketplace", "projects"], "Settings approval");
  if (![approval.personalMarketplace, approval.projects].every((mode) => mode === "conversation" || mode === "omni"))
    throw new Error("Settings approval mode is invalid.");
  return {
    approval: {
      personalMarketplace: approval.personalMarketplace as ApprovalMode,
      projects: approval.projects as ApprovalMode,
    },
    guard: parseGuard(agents.guard),
    ...(agents.installedByVersion === undefined
      ? {}
      : { installedByVersion: text(agents.installedByVersion, "Agent installation version") }),
  };
}
export function parseSettingsSetRequest(value: unknown): SettingsSetRequest {
  const request = record(value, "Settings request");
  keys(
    request,
    ["commitChanges", "agents", "ai", "features", "externalLibrary", "workspaceSetupHidden"],
    "Settings request",
  );
  if (typeof request.commitChanges !== "boolean") throw new Error("commitChanges must be a boolean.");
  return {
    ...parseWorkspaceSetupPreference(request),
    commitChanges: request.commitChanges,
    agents: parseAgents(request.agents),
    ai: parseAi(request.ai),
    features: parseFeatures(request.features),
    externalLibrary: parseExternalLibrary(request.externalLibrary),
  };
}
export function parseEmptySettingsRequest(value: unknown): void {
  const request = record(value, "Settings request");
  keys(request, [], "Settings request");
}
export function parseSettingsResponse(value: unknown): Settings {
  const response = record(value, "Settings response");
  keys(
    response,
    ["schemaVersion", "git", "agents", "ai", "features", "externalLibrary", "login", "workspaceSetupHidden"],
    "Settings response",
  );
  const git = record(response.git, "Settings git settings");
  keys(git, ["commitChanges"], "Settings git settings");
  if (response.schemaVersion !== 8 || typeof git.commitChanges !== "boolean")
    throw new Error("Settings response is invalid.");
  return {
    schemaVersion: 8,
    ...parseWorkspaceSetupPreference(response),
    ...(response.login === undefined ? {} : { login: parseLoginDecision(response.login) }),
    git: { commitChanges: git.commitChanges },
    agents: parseAgents(response.agents),
    ai: parseAi(response.ai),
    features: parseFeatures(response.features),
    externalLibrary: parseExternalLibrary(response.externalLibrary),
  };
}
function parseWorkspaceSetupPreference(value: RecordValue): Readonly<{ workspaceSetupHidden?: boolean }> {
  if (value.workspaceSetupHidden === undefined) return {};
  if (typeof value.workspaceSetupHidden !== "boolean") throw new Error("Workspace setup visibility must be a boolean.");
  return { workspaceSetupHidden: value.workspaceSetupHidden };
}
function parseExternalLibrary(value: unknown): ExternalLibrarySettings {
  const settings = record(value, "External library settings");
  keys(settings, ["updates"], "External library settings");
  if (settings.updates !== "auto" && settings.updates !== "ask")
    throw new Error("External library updates must be auto or ask.");
  return { updates: settings.updates };
}
export interface SettingsDesktopApi {
  getSettings(): Promise<Settings>;
  setSettings(request: SettingsSetRequest): Promise<Settings>;
}

export function parseLoginDecision(value: unknown): Readonly<{ openAtLogin: boolean }> {
  const decision = record(value, "Login decision");
  keys(decision, ["openAtLogin"], "Login decision");
  if (typeof decision.openAtLogin !== "boolean") throw new Error("Login decision must be a boolean.");
  return { openAtLogin: decision.openAtLogin };
}
