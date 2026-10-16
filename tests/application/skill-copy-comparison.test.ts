import { createHash } from "node:crypto";
import { expect, test } from "vitest";

import { createSkillCopyComparisonService } from "../../src/application/skill-copy-comparison";
import type {
  SkillRelationshipsState,
  SkillLocationKey,
  SkillRevision,
} from "../../src/domain/skill-reconciliation/types";
import type { SkillRelationshipStore, SkillObservationGrant } from "../../src/ports/skill-reconciliation";
import type { SkillCopyComparisonReader } from "../../src/ports/skill-copy-comparison";

const a: SkillLocationKey = { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/review" };
const b: SkillLocationKey = { projectId: "project-one", harnessId: "claude-code", folderPath: ".claude/skills/review" };
const unrelated: SkillLocationKey = {
  projectId: "project-one",
  harnessId: "cursor",
  folderPath: ".cursor/skills/other",
};
const skillId = "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18";
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function revision(entries: readonly Readonly<{ path: string; text: string }>[]): SkillRevision {
  const files = entries.map(({ path, text }) => ({ path, hash: digest(text), byteLength: Buffer.byteLength(text) }));
  return {
    algorithm: "omni-tree-v1",
    hash: digest(files.map((file) => `${file.path}:${file.hash}`).join("\n")),
    files,
  };
}

function state(locations: readonly SkillLocationKey[] = [a, b], revisionNumber = 4): SkillRelationshipsState {
  return {
    schemaVersion: 1,
    revision: revisionNumber,
    skills: [{ skillId, label: "review", evidence: "observed-equivalence", locations }],
    uses: [],
  };
}

function setup(
  options: Readonly<{
    mutateAfterRead?: () => void;
    locations?: readonly SkillLocationKey[];
    reader?: SkillCopyComparisonReader;
    omitAFile?: string;
  }> = {},
) {
  let storeReads = 0;
  let currentState = state(options.locations);
  let saves = 0;
  const store: SkillRelationshipStore = {
    async read() {
      storeReads += 1;
      return { status: "ready", state: currentState };
    },
    async compareAndSave() {
      saves += 1;
      throw new Error("Comparison must never save relationship state.");
    },
    async updateUsesExact() {
      throw new Error("Comparison must never update managed uses.");
    },
  };
  const defaultReader: SkillCopyComparisonReader = {
    async readPair() {
      options.mutateAfterRead?.();
      const aFiles = new Map([
        ["SKILL.md", Buffer.from("# A\n")],
        ["a-only.md", Buffer.from("A\n")],
      ]);
      if (options.omitAFile) aFiles.delete(options.omitAFile);
      return {
        a: {
          status: "complete",
          revision: revision([
            { path: "SKILL.md", text: "# A\n" },
            { path: "a-only.md", text: "A\n" },
          ]),
          files: aFiles,
        },
        b: {
          status: "complete",
          revision: revision([
            { path: "SKILL.md", text: "# B\n" },
            { path: "b-only.md", text: "B\n" },
          ]),
          files: new Map([
            ["SKILL.md", Buffer.from("# B\n")],
            ["b-only.md", Buffer.from("B\n")],
          ]),
        },
      };
    },
  };
  const reader = options.reader ?? defaultReader;
  const grant: SkillObservationGrant = {
    root: "/tmp/project-one",
    subject: { kind: "project", id: "project-one" },
    device: "1",
    inode: "2",
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const service = createSkillCopyComparisonService({ store, reader });
  return {
    service,
    grant,
    getStoreReads: () => storeReads,
    getSaves: () => saves,
    replaceState: (next: SkillRelationshipsState) => {
      currentState = next;
    },
  };
}

test("compares an exact persisted pair without changing relationships or exposing source authority", async () => {
  const harness = setup();
  const response = await harness.service.readComparison(
    { projectId: "project-one", grantHandle: "grant-one", skillId, a, b },
    harness.grant,
  );
  expect(response.status).toBe("ready");
  if (response.status !== "ready") return;
  expect(response.files.map((file) => [file.path, file.change])).toEqual([
    ["SKILL.md", "change"],
    ["a-only.md", "delete"],
    ["b-only.md", "add"],
  ]);
  expect(response.selectedPath).toBe("SKILL.md");
  expect(response.presentation).toMatchObject({ presentation: "text", diff: expect.stringContaining("# A") });
  expect(response.evidence).toEqual({ source: "unknown", base: "unknown", relationship: "observed-equivalence" });
  expect(harness.getStoreReads()).toBe(2);
  expect(harness.getSaves()).toBe(0);
  expect(JSON.stringify(response)).not.toMatch(/bytes|sourcePath|basePath|uses|bindings/i);
});

test("rejects locations that are not the exact two members of one persisted logical skill", async () => {
  const harness = setup();
  await expect(
    harness.service.readComparison(
      { projectId: "project-one", grantHandle: "grant-one", skillId, a, b: unrelated },
      harness.grant,
    ),
  ).resolves.toMatchObject({ status: "unavailable", reason: "membership" });
  await expect(
    harness.service.readComparison(
      { projectId: "project-one", grantHandle: "grant-one", skillId, a, b: a },
      harness.grant,
    ),
  ).resolves.toMatchObject({ status: "unavailable", reason: "membership" });
});

test("rechecks persisted membership after the asynchronous pair read", async () => {
  const harness = setup({ mutateAfterRead: () => harness.replaceState(state([a, unrelated], 5)) });
  await expect(
    harness.service.readComparison(
      { projectId: "project-one", grantHandle: "grant-one", skillId, a, b },
      harness.grant,
    ),
  ).resolves.toMatchObject({ status: "unavailable", reason: "membership" });
  expect(harness.getSaves()).toBe(0);
});

test("does not infer comparison when either copy is unavailable", async () => {
  const reader: SkillCopyComparisonReader = {
    async readPair() {
      return {
        a: { status: "unavailable", reason: "denied" },
        b: { status: "complete", revision: revision([]), files: new Map() },
      };
    },
  };
  const harness = setup({ reader });
  await expect(
    harness.service.readComparison(
      { projectId: "project-one", grantHandle: "grant-one", skillId, a, b },
      harness.grant,
    ),
  ).resolves.toMatchObject({ status: "unavailable", reason: "read" });
  expect(harness.getSaves()).toBe(0);
});

test("rejects a captured byte map that does not match its complete revision", async () => {
  const harness = setup({ omitAFile: "a-only.md" });
  await expect(
    harness.service.readComparison(
      { projectId: "project-one", grantHandle: "grant-one", skillId, a, b },
      harness.grant,
    ),
  ).resolves.toMatchObject({ status: "unavailable", reason: "read" });
});
