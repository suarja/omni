import { describe, expect, it } from "vitest";

import { compatibilityMatrix, visibleIn } from "../../src/domain/compatibility";

describe("compatibility classification", () => {
  it("exposes the deterministic protocol matrix with reasons", () => {
    expect(compatibilityMatrix.skill["claude-code"]).toEqual({
      status: "yes",
      reason: "The same skill folder is discovered by both harnesses.",
    });
    expect(compatibilityMatrix.command.codex).toEqual({ status: "no", reason: "Codex has no command files." });
    expect(compatibilityMatrix.hook.codex.status).toBe("partial");
    expect(compatibilityMatrix.hook.codex.reason).toMatch(/schema/i);
    expect(compatibilityMatrix["mcp-config"].cursor.status).toBe("yes");
  });

  it("reports visibility from the manifests actually present", () => {
    expect(
      visibleIn({ manifestPaths: ["omni.plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"] }),
    ).toEqual(["omni", "claude-code", "codex"]);
    expect(visibleIn({ manifestPaths: ["plugins/pstack/.claude-plugin/plugin.json"] })).toEqual(["claude-code"]);
  });
});
