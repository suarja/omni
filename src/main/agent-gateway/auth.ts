import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type AgentTokenManager = Readonly<{
  ensure(): Promise<string>;
  rotate(): Promise<string>;
  tokenCreatedAt(): Promise<string>;
}>;

function tokenPath(userDataPath: string): string {
  return join(resolve(userDataPath), "omni", "agent-token");
}

async function assertRegular(path: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("The agent token file is not a regular file.");
}

function validToken(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

async function writeToken(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function createAgentToken(userDataPath: string): Promise<string> {
  const path = tokenPath(userDataPath);
  try {
    await assertRegular(path);
    const token = (await readFile(path, "utf8")).trim();
    if (!validToken(token)) throw new Error("The agent token file is invalid.");
    await chmod(path, 0o600);
    return token;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      const token = randomBytes(32).toString("hex");
      await writeToken(path, token);
      return token;
    }
    throw error;
  }
}

export function createAgentTokenManager(userDataPath: string): AgentTokenManager & Readonly<{ path: string }> {
  const path = tokenPath(userDataPath);
  return {
    path,
    ensure: () => createAgentToken(userDataPath),
    rotate: async () => {
      const token = randomBytes(32).toString("hex");
      await writeToken(path, token);
      return token;
    },
    tokenCreatedAt: async () => {
      await createAgentToken(userDataPath);
      const details = await lstat(path);
      return details.birthtime.toISOString();
    },
  };
}
