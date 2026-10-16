import { describe, expect, it } from "vitest";

import { resolveTarget, type HarnessId } from "../../src/domain/harness-targets";

const harnesses: readonly HarnessId[] = ["claude-code", "codex", "cursor"];

describe("harness target resolution", () => {
  it("resolves every supported skill target", () => {
    expect(harnesses.map((harnessId) => resolveTarget({ kind: "skill", id: "review", harnessId }))).toEqual([
      { status: "target", relativePath: ".claude/skills/review", unit: "folder" },
      { status: "target", relativePath: ".agents/skills/review", unit: "folder" },
      { status: "target", relativePath: ".cursor/skills/review", unit: "folder" },
    ]);
  });

  it("resolves provider instruction filenames and blocks Cursor", () => {
    expect(resolveTarget({ kind: "instruction", id: "project", harnessId: "claude-code" })).toEqual({
      status: "target",
      relativePath: "CLAUDE.md",
      unit: "file",
    });
    expect(resolveTarget({ kind: "instruction", id: "project", harnessId: "codex" })).toEqual({
      status: "target",
      relativePath: "AGENTS.md",
      unit: "file",
    });
    expect(resolveTarget({ kind: "instruction", id: "project", harnessId: "cursor" })).toMatchObject({
      status: "blocked",
    });
  });

  it("resolves Claude commands and agents and returns matrix reasons for other harnesses", () => {
    expect(resolveTarget({ kind: "command", id: "review", harnessId: "claude-code" })).toEqual({
      status: "target",
      relativePath: ".claude/commands/review.md",
      unit: "file",
    });
    expect(resolveTarget({ kind: "agent", id: "reviewer", harnessId: "claude-code" })).toEqual({
      status: "target",
      relativePath: ".claude/agents/reviewer.md",
      unit: "file",
    });
    expect(resolveTarget({ kind: "command", id: "review", harnessId: "codex" })).toEqual({
      status: "blocked",
      reason: "Codex has no command files.",
    });
    expect(resolveTarget({ kind: "agent", id: "reviewer", harnessId: "cursor" })).toEqual({
      status: "blocked",
      reason: "Cursor has no deterministic agent projection.",
    });
  });

  it("blocks provider actions for hooks and MCP configuration", () => {
    for (const kind of ["hook", "mcp-config"] as const) {
      for (const harnessId of harnesses) {
        expect(resolveTarget({ kind, id: "entry", harnessId })).toEqual({
          status: "blocked",
          reason: "provider action (M4)",
        });
      }
    }
  });

  it("rejects unsafe target ids", () => {
    for (const id of ["", "a/b", "../a", "a/..", "a\u0000b", "a\n b"]) {
      expect(() => resolveTarget({ kind: "skill", id, harnessId: "claude-code" })).toThrow(/id/i);
    }
  });
});
