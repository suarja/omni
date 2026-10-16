import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createKeyStore, readKey, type SafeStorageLike } from "../../src/main/inference/keys";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempKeysPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omni-inference-keys-"));
  roots.push(root);
  return join(root, "inference-keys.bin");
}

/** A stub of Electron's `safeStorage` that "encrypts" with a reversible marker — never the real Keychain. */
function stubSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`, "utf8"),
    decryptString: (encrypted: Buffer) => encrypted.toString("utf8").replace(/^enc:/, ""),
  };
}

describe("inference key store", () => {
  it("stores a key encrypted, reports only presence, and never returns the plain key from hasKey/presence", async () => {
    const filePath = await tempKeysPath();
    const safeStorage = stubSafeStorage();
    const store = createKeyStore(filePath, safeStorage);

    await expect(store.hasKey("anthropic")).resolves.toBe(false);
    await expect(store.setKey("anthropic", "sk-ant-secret")).resolves.toEqual({ status: "ok" });
    await expect(store.hasKey("anthropic")).resolves.toBe(true);
    await expect(store.presence()).resolves.toMatchObject({
      anthropic: true,
      openai: false,
      custom: false,
      ollama: false,
      lmstudio: false,
    });

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("sk-ant-secret");
    const stored = JSON.parse(raw) as Readonly<{ anthropic: string }>;
    expect(Buffer.from(stored.anthropic, "base64").toString("utf8")).toBe("enc:sk-ant-secret");
  });

  it("writes the key file with mode 0600", async () => {
    const filePath = await tempKeysPath();
    const store = createKeyStore(filePath, stubSafeStorage());
    await store.setKey("openai", "sk-openai-secret");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("clears a key", async () => {
    const filePath = await tempKeysPath();
    const store = createKeyStore(filePath, stubSafeStorage());
    await store.setKey("anthropic", "sk-ant-secret");
    await expect(store.clearKey("anthropic")).resolves.toEqual({ status: "ok" });
    await expect(store.hasKey("anthropic")).resolves.toBe(false);
  });

  it("refuses to store a key when encryption is unavailable, and never writes it in the clear", async () => {
    const filePath = await tempKeysPath();
    const store = createKeyStore(filePath, stubSafeStorage(false));
    const result = await store.setKey("anthropic", "sk-ant-secret");
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") expect(result.reason.length).toBeGreaterThan(0);
    await expect(store.hasKey("anthropic")).resolves.toBe(false);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  it("reports encryptionAvailable() from the underlying safeStorage", async () => {
    const filePath = await tempKeysPath();
    expect(createKeyStore(filePath, stubSafeStorage(true)).encryptionAvailable()).toBe(true);
    expect(createKeyStore(`${filePath}.2`, stubSafeStorage(false)).encryptionAvailable()).toBe(false);
  });

  it("readKey decrypts the plain key for a provider that needs to call out — the only reader of plain content", async () => {
    const filePath = await tempKeysPath();
    const safeStorage = stubSafeStorage();
    const store = createKeyStore(filePath, safeStorage);
    await store.setKey("openai", "sk-openai-secret");
    await expect(readKey(filePath, safeStorage, "openai")).resolves.toBe("sk-openai-secret");
    await expect(readKey(filePath, safeStorage, "anthropic")).resolves.toBeUndefined();
  });
});
