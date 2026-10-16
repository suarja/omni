import { describe, expect, it } from "vitest";

import { parsePreviewOperationRequest } from "../../src/shared/operations-ipc";
import { parseInstallAgentsRequest } from "../../src/shared/operations-install-agents-ipc";

describe("install-agents IPC boundary", () => {
  it("accepts force reinstall and rejects non-boolean force values", () => {
    expect(parseInstallAgentsRequest({ kind: "install-agents", harnesses: ["codex"], force: true })).toMatchObject({
      force: true,
    });
    expect(() => parseInstallAgentsRequest({ kind: "install-agents", harnesses: ["codex"], force: "yes" })).toThrow();
  });
  it("accepts unique harnesses and rejects empty or duplicate selections", () => {
    expect(parseInstallAgentsRequest({ kind: "install-agents", harnesses: ["claude-code", "codex"] })).toEqual({
      kind: "install-agents",
      harnesses: ["claude-code", "codex"],
    });
    expect(parsePreviewOperationRequest({ kind: "install-agents", harnesses: ["codex"] })).toEqual({
      kind: "install-agents",
      harnesses: ["codex"],
    });
    expect(() => parseInstallAgentsRequest({ kind: "install-agents", harnesses: [] })).toThrow();
    expect(() => parseInstallAgentsRequest({ kind: "install-agents", harnesses: ["codex", "codex"] })).toThrow();
  });
});
