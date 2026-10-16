import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseAgentMutationResponse, type AgentRequest } from "../../shared/agents-ipc";
import { isMissing } from "../fs-optional";

export type AgentRequestsState = Readonly<{ schemaVersion: 1; requests: readonly AgentRequest[] }>;
type RejectedRequest = Readonly<{ index: number; error: unknown }>;

function parseState(value: unknown): Readonly<{ state: AgentRequestsState; rejected: readonly RejectedRequest[] }> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Agent requests are invalid.");
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    !Array.isArray(record.requests) ||
    Object.keys(record).some((key) => !["schemaVersion", "requests"].includes(key))
  )
    throw new Error("Agent requests are invalid.");
  const requests: AgentRequest[] = [];
  const rejected: RejectedRequest[] = [];
  for (const [index, item] of record.requests.entries()) {
    try {
      requests.push(parseAgentMutationResponse(item));
    } catch (error: unknown) {
      rejected.push({ index, error });
    }
  }
  return { state: { schemaVersion: 1, requests }, rejected };
}

export async function writeAgentRequestsState(path: string, state: AgentRequestsState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readAgentRequestsState(path: string): Promise<AgentRequestsState> {
  let original: Buffer;
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Agent requests file is not regular.");
    original = await readFile(path);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    return { schemaVersion: 1, requests: [] };
  }
  const { state, rejected } = parseState(JSON.parse(original.toString("utf8")) as unknown);
  if (!rejected.length) return state;
  const quarantinePath = `${path}.quarantine.${randomUUID()}.json`;
  // Preserve the whole original file to retain rejected entries byte for byte.
  // Never rewrite the live store unless this exclusive, private copy succeeds.
  await writeFile(quarantinePath, original, { mode: 0o600, flag: "wx" });
  for (const { index, error } of rejected) {
    const diagnostic = error instanceof Error ? error.message : "Agent request could not be read safely.";
    console.warn(`Agent request at index ${index} in ${path} was quarantined in ${quarantinePath}: ${diagnostic}`);
  }
  await writeAgentRequestsState(path, state);
  return state;
}
