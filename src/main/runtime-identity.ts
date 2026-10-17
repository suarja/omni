import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type BuildChannel = "release" | "development";
export type BuildIdentity = Readonly<{
  version: string;
  commit: string;
  channel: BuildChannel;
  builtAt: string;
  platform: string;
  arch: string;
  protocolVersion: string;
  agentBundleHash: string;
  signing?: string;
}>;

export type ProfilePolicy = Readonly<{
  channel: BuildChannel;
  profilePath: string;
  source: "default" | "environment" | "argument";
}>;

type BuildInfo = Partial<Record<keyof BuildIdentity, unknown>>;

export type BuildIdentityOptions = Readonly<{
  appRoot: string;
  isPackaged: boolean;
  fallbackVersion: string;
  platform: string;
  arch: string;
  readBuildInfo?: (path: string) => Promise<string | undefined>;
}>;

export type ProfilePolicyOptions = Readonly<{
  isPackaged: boolean;
  homePath?: string;
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}>;

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Build metadata field ${name} is missing or invalid.`);
  return value.trim();
}

function channel(value: unknown, packaged: boolean): BuildChannel {
  if (value === undefined) return packaged ? "release" : "development";
  if (value !== "release" && value !== "development") throw new Error("Build metadata field channel is invalid.");
  return value;
}

function parseBuildInfo(raw: string, options: BuildIdentityOptions): BuildIdentity {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Packaged Omni build-info.json is invalid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Build metadata must be an object.");
  const info = value as BuildInfo;
  return {
    version: nonEmpty(info.version, "version"),
    commit: nonEmpty(info.commit, "commit"),
    channel: channel(info.channel, options.isPackaged),
    builtAt: nonEmpty(info.builtAt, "builtAt"),
    platform: nonEmpty(info.platform, "platform"),
    arch: nonEmpty(info.arch, "arch"),
    protocolVersion: nonEmpty(info.protocolVersion, "protocolVersion"),
    agentBundleHash: nonEmpty(info.agentBundleHash, "agentBundleHash"),
    ...(info.signing === undefined ? {} : { signing: nonEmpty(info.signing, "signing") }),
  };
}

export async function loadBuildIdentity(options: BuildIdentityOptions): Promise<BuildIdentity> {
  const read = options.readBuildInfo ?? (async (path: string) => readFile(path, "utf8").catch(() => undefined));
  const raw = await read(join(options.appRoot, "build-info.json"));
  if (raw !== undefined) return parseBuildInfo(raw, options);
  if (options.isPackaged) throw new Error("Packaged Omni build is missing build-info.json.");
  return {
    version: options.fallbackVersion,
    commit: "development",
    channel: "development",
    builtAt: "development",
    platform: options.platform,
    arch: options.arch,
    protocolVersion: "development",
    agentBundleHash: "development",
  };
}

function argumentProfile(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--user-data-dir");
  const separate = index >= 0 ? argv[index + 1] : undefined;
  if (separate && !separate.startsWith("-")) return separate;
  const inline = argv.find((item) => item.startsWith("--user-data-dir="));
  return inline?.slice("--user-data-dir=".length) || undefined;
}

export function resolveProfilePolicy(options: ProfilePolicyOptions): ProfilePolicy {
  const channelValue: BuildChannel = options.isPackaged ? "release" : "development";
  const argument = argumentProfile(options.argv ?? process.argv);
  const environment = options.env === undefined ? process.env.OMNI_USER_DATA : options.env.OMNI_USER_DATA;
  const explicit = argument ?? environment;
  if (explicit?.trim()) {
    const profilePath = explicit.trim();
    if (!isAbsolute(profilePath)) throw new Error("Explicit Omni profile path must be an absolute path.");
    const root = join(options.homePath ?? homedir(), "Library", "Application Support");
    const reservedChannel = channelValue === "release" ? "development" : "release";
    const reservedProfile = resolve(root, reservedChannel === "release" ? "Omni" : "Omni Dev");
    if (resolve(profilePath) === reservedProfile) {
      throw new Error(`Explicit Omni profile path is reserved for the ${reservedChannel} profile.`);
    }
    return {
      channel: channelValue,
      profilePath,
      source: argument ? "argument" : "environment",
    };
  }
  const root = join(options.homePath ?? homedir(), "Library", "Application Support");
  return {
    channel: channelValue,
    profilePath: join(root, channelValue === "release" ? "Omni" : "Omni Dev"),
    source: "default",
  };
}
