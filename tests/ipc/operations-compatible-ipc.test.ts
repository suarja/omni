import { describe, expect, it } from "vitest";

import { parseCompatibilityReport } from "../../src/shared/operations-compatible-ipc";
import { parsePreviewOperationRequest } from "../../src/shared/operations-ipc";

describe("compatible operation IPC", () => {
  it("parses a bounded preview request and report", () => {
    expect(
      parsePreviewOperationRequest({
        kind: "make-compatible",
        sourceId: "source-one",
        packageId: "packages/tools",
        harness: "codex",
        keepUpdates: ["packages/tools/.codex-plugin/plugin.json"],
      }),
    ).toEqual({
      kind: "make-compatible",
      sourceId: "source-one",
      packageId: "packages/tools",
      harness: "codex",
      keepUpdates: ["packages/tools/.codex-plugin/plugin.json"],
    });

    expect(
      parseCompatibilityReport({
        harness: "codex",
        packages: [
          {
            packageId: "tools",
            name: "tools",
            path: "packages/tools",
            verdict: "ready",
            alreadyCompatible: true,
            artifacts: [{ path: "skills/review/SKILL.md", kind: "skill", status: "transposable" }],
          },
        ],
      }),
    ).toMatchObject({ harness: "codex", packages: [{ packageId: "tools" }] });
  });

  it("rejects absolute paths and unknown fields", () => {
    expect(() =>
      parsePreviewOperationRequest({
        kind: "make-compatible",
        sourceId: "source-one",
        harness: "codex",
        keepUpdates: ["/tmp/secret"],
      }),
    ).toThrow();
    expect(() =>
      parseCompatibilityReport({
        harness: "codex",
        packages: [],
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parseCompatibilityReport({
        harness: "codex",
        packages: [
          {
            packageId: "tools",
            path: "packages/tools",
            verdict: "blocked",
            reason: "/tmp/private",
            artifacts: [],
          },
        ],
      }),
    ).toThrow();
  });
});
