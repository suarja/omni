import { describe, expect, it } from "vitest";

import {
  aggregateSkillAttention,
  deriveManagedSkillAttention,
  deriveSkillAttention,
} from "../../src/domain/skill-reconciliation/attention";
import type { SkillCopyLocationRead, SkillRevision } from "../../src/domain/skill-reconciliation/types";

const revision = (hash: string): SkillRevision => ({ algorithm: "omni-tree-v1", hash, files: [] });
const location = (folderPath: string) => ({ projectId: "project", harnessId: "codex" as const, folderPath });
const read = (folderPath: string, hash: string): SkillCopyLocationRead => ({
  location: location(folderPath),
  read: { status: "complete", revision: revision(hash) },
});

describe("managed skill attention", () => {
  it("marks a single local copy changed from its verified base", () => {
    expect(deriveManagedSkillAttention("local-change")).toEqual({ state: "local-change", reasons: ["local-change"] });
  });

  it("keeps attention when multiple managed copies share the same local edit", () => {
    const copies = [read(".agents/skills/demo", "a"), read(".claude/skills/demo", "a")];
    const combined = aggregateSkillAttention([
      deriveSkillAttention(copies),
      deriveManagedSkillAttention("local-change"),
      deriveManagedSkillAttention("local-change"),
    ]);
    expect(combined).toEqual({ state: "local-change", reasons: ["local-change"] });
  });

  it("keeps missing or corrupt base evidence unavailable without inferring source freshness", () => {
    expect(deriveManagedSkillAttention("unavailable")).toEqual({ state: "unavailable", reasons: ["unavailable"] });
    expect(deriveManagedSkillAttention(undefined)).toEqual({ state: "quiet", reasons: [] });
    expect(deriveSkillAttention([read(".agents/skills/demo", "a")])).toEqual({ state: "quiet", reasons: [] });
  });
});
