// Request parsing for the "write-harness-setting" operation (D6, worktree hygiene): a single
// key/value edit of a harness's own settings file, reusing the register-mcp preview→apply→result
// grammar. Only Claude Code's `cleanupPeriodDays` is wired today — Codex has no such setting yet
// (its row on the cleanup page is informational only, with no operation behind it).
import { assertKeys, assertRecord, readText } from "./operations-ipc-parser-utils";

export type WriteHarnessSettingHarness = "claude-code";
export type WriteHarnessSettingKey = "cleanupPeriodDays";
export type WriteHarnessSettingRequest = Readonly<{
  kind: "write-harness-setting";
  harness: WriteHarnessSettingHarness;
  key: WriteHarnessSettingKey;
  value: number | null;
}>;

const MAX_DAYS = 3_650;

export function parseWriteHarnessSettingRequest(value: unknown): WriteHarnessSettingRequest {
  const request = assertRecord(value, "Harness setting request");
  assertKeys(request, ["kind", "harness", "key", "value"], "Harness setting request");
  if (request.kind !== "write-harness-setting") throw new Error("Operation kind is invalid.");
  const harness = readText(request.harness, "Harness setting harness");
  if (harness !== "claude-code") throw new Error("Harness setting harness is invalid.");
  const key = readText(request.key, "Harness setting key");
  if (key !== "cleanupPeriodDays") throw new Error("Harness setting key is invalid.");
  if (
    request.value !== null &&
    (typeof request.value !== "number" ||
      !Number.isInteger(request.value) ||
      request.value <= 0 ||
      request.value > MAX_DAYS)
  ) {
    throw new Error("Harness setting value is invalid.");
  }
  return { kind: "write-harness-setting", harness, key, value: request.value };
}
