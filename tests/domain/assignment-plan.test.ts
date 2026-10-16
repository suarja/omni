import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { planAssignment, type Binding, type TargetEvidence } from "../../src/domain/assignment-plan";

const unitHash = createHash("sha256").update("marketplace", "utf8").digest("hex");
const oldHash = createHash("sha256").update("owned", "utf8").digest("hex");
const foreignHash = createHash("sha256").update("local", "utf8").digest("hex");

const binding: Binding = {
  bindingId: "binding-one",
  sourceId: "source-one",
  packageId: "package-one",
  artifactPath: "skills/review",
  kind: "skill",
  projectId: "project-one",
  harnessId: "claude-code",
  boundHash: oldHash,
  ownedHash: oldHash,
  createdAt: "2026-09-13T10:00:00.000Z",
};

function target(overrides: Partial<TargetEvidence> = {}): TargetEvidence {
  return {
    harnessId: "claude-code",
    relativePath: ".claude/skills/review",
    exists: false,
    providerManaged: false,
    ...overrides,
  };
}

function plan(targets: readonly TargetEvidence[], bindings: readonly Binding[] = [binding]) {
  return planAssignment({
    unit: { kind: "skill", id: "review", contentHash: unitHash },
    project: { projectId: "project-one", targets },
    bindings,
  });
}

describe("deterministic assignment planning", () => {
  it.each([
    ["add", target(), undefined],
    ["current", target({ exists: true, contentHash: unitHash }), undefined],
    [
      "update",
      target({ exists: true, contentHash: foreignHash }),
      [{ ...binding, boundHash: foreignHash, ownedHash: foreignHash }],
    ],
    ["conflict", target({ exists: true, contentHash: foreignHash }), undefined],
    ["blocked", target({ exists: true, contentHash: foreignHash, providerManaged: true }), undefined],
  ] as [string, TargetEvidence, readonly Binding[] | undefined][])(
    "returns %s",
    (state, evidence, bindings = [binding]) => {
      const result = plan([evidence], bindings);
      expect(result.actions[0]).toMatchObject({ state, relativePath: evidence.relativePath, harnessId: "claude-code" });
      expect(result.status).toBe(state === "conflict" ? "conflict" : state === "blocked" ? "blocked" : "ready");
    },
  );

  it("returns linked for an in-project projection of the same unit", () => {
    const result = plan([
      target({
        exists: true,
        contentHash: foreignHash,
        symlinkTarget: ".agents/skills/review",
      }),
    ]);
    expect(result).toMatchObject({ status: "ready", actions: [{ state: "linked" }] });
  });

  it("sorts actions and hashes canonical inputs independent of input order", () => {
    const second: Binding = { ...binding, bindingId: "binding-two", harnessId: "codex" };
    const targets = [
      target(),
      target({ harnessId: "codex", relativePath: ".agents/skills/review", exists: true, contentHash: unitHash }),
    ];
    const first = plan(targets, [second, binding]);
    const shuffled = plan([...targets].reverse(), [binding, second]);
    expect(shuffled).toEqual(first);
    expect(first.actions.map((action) => [action.harnessId, action.relativePath])).toEqual([
      ["claude-code", ".claude/skills/review"],
      ["codex", ".agents/skills/review"],
    ]);
  });

  it("uses ownedHash before the legacy boundHash for update ownership", () => {
    const ownedHash = "c".repeat(64);
    const ownedBinding = { ...binding, boundHash: oldHash, ownedHash };
    expect(plan([target({ exists: true, contentHash: oldHash })], [ownedBinding]).actions[0]?.state).toBe("conflict");
    expect(plan([target({ exists: true, contentHash: ownedHash })], [ownedBinding]).actions[0]?.state).toBe("update");
  });
});
