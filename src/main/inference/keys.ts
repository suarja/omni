// The one key store (Brief 35a): an API key never sits in `settings.json` and never crosses
// into the renderer — `setKey`/`clearKey` are the only path it travels (renderer → main, once),
// and every reader outside this file only ever learns a boolean (`hasKey`). Encrypted at rest
// with Electron's `safeStorage`; when encryption is unavailable on the platform, storing a key
// is refused with the reason rather than written in the clear.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { PresetId } from "../../shared/ai-gateway-ipc";

export type ApiKeyProviderId = PresetId;

/** The slice of Electron's `safeStorage` this module needs — injectable so tests never touch the real Keychain. */
export type SafeStorageLike = Readonly<{
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}>;

export type KeyMutationResult = Readonly<{ status: "ok" }> | Readonly<{ status: "unavailable"; reason: string }>;

export type KeyPresence = Readonly<Record<PresetId, boolean>>;

export type KeyStore = Readonly<{
  setKey(providerId: ApiKeyProviderId, key: string): Promise<KeyMutationResult>;
  hasKey(providerId: ApiKeyProviderId): Promise<boolean>;
  clearKey(providerId: ApiKeyProviderId): Promise<KeyMutationResult>;
  presence(): Promise<KeyPresence>;
  encryptionAvailable(): boolean;
  /**
   * The one path a provider travels to get the plain key, at
   * call time only — never stored anywhere but this file's own decrypt, never logged.
   */
  readKey(providerId: ApiKeyProviderId): Promise<string | undefined>;
}>;

const ENCRYPTION_UNAVAILABLE_REASON =
  "This machine has no available OS-level encryption (Keychain, Credential Manager, or libsecret): storing a key here would write it in the clear, so Omni refuses.";

type StoredKeys = Partial<Record<ApiKeyProviderId, string>>;

const PRESET_IDS: readonly ApiKeyProviderId[] = [
  "anthropic",
  "openai",
  "openrouter",
  "vercel-ai-gateway",
  "groq",
  "mistral",
  "ollama",
  "lmstudio",
  "custom",
];

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readStore(filePath: string): Promise<StoredKeys> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const result: StoredKeys = {};
    for (const preset of PRESET_IDS) if (typeof record[preset] === "string") result[preset] = record[preset] as string;
    return result;
  } catch (error: unknown) {
    if (!isMissing(error)) return {};
    return {};
  }
}

async function writeStoreAtomically(filePath: string, data: StoredKeys): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function inferenceKeysFilePath(userDataPath: string): string {
  return join(resolve(userDataPath), "omni", "inference-keys.bin");
}

export function createKeyStore(filePath: string, safeStorage: SafeStorageLike): KeyStore {
  let queue = Promise.resolve();
  const mutate = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    setKey: (providerId, key) =>
      mutate(async (): Promise<KeyMutationResult> => {
        if (!safeStorage.isEncryptionAvailable())
          return { status: "unavailable", reason: ENCRYPTION_UNAVAILABLE_REASON };
        const encrypted = safeStorage.encryptString(key).toString("base64");
        const existing = await readStore(filePath);
        await writeStoreAtomically(filePath, { ...existing, [providerId]: encrypted });
        return { status: "ok" };
      }),
    hasKey: (providerId) =>
      mutate(async () => {
        const existing = await readStore(filePath);
        return typeof existing[providerId] === "string" && existing[providerId]!.length > 0;
      }),
    clearKey: (providerId) =>
      mutate(async (): Promise<KeyMutationResult> => {
        const existing = await readStore(filePath);
        const { [providerId]: _removed, ...rest } = existing;
        await writeStoreAtomically(filePath, rest);
        return { status: "ok" };
      }),
    presence: () =>
      mutate(async (): Promise<KeyPresence> => {
        const existing = await readStore(filePath);
        return Object.fromEntries(
          PRESET_IDS.map((preset) => [preset, typeof existing[preset] === "string" && existing[preset]!.length > 0]),
        ) as KeyPresence;
      }),
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    readKey: (providerId) => mutate(() => readKey(filePath, safeStorage, providerId)),
  };
}

/**
 * Only for a provider that needs the plain key to call out (Brief 35b's `api-key` provider) —
 * never for anything that would echo it back toward a renderer. Kept in this module so a key is
 * decrypted in exactly one place.
 */
export async function readKey(
  filePath: string,
  safeStorage: SafeStorageLike,
  providerId: ApiKeyProviderId,
): Promise<string | undefined> {
  const existing = await readStore(filePath);
  const encoded = existing[providerId];
  if (!encoded) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return undefined;
  }
}
