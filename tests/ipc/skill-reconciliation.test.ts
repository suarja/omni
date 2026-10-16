import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { afterEach, vi } from "vitest";

import {
  parseObserveSkillCopiesRequest,
  parseObserveSkillCopiesResponse,
} from "../../src/shared/skill-reconciliation-ipc";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("electron");
});

const request = {
  projectId: "project-one",
  grantHandle: "grant-one",
  groups: [
    {
      groupId: "individual-skills",
      members: [
        {
          ref: { kind: "artifact", entry: { kind: "project", id: "project-one" }, artifactId: "inventory-abc" },
          relativePath: ".agents/skills/design-bank/SKILL.md",
        },
      ],
    },
  ],
};

const response = {
  status: "ready",
  storeRevision: 1,
  managedUses: [],
  retainedSkills: [],
  groups: [
    {
      groupId: "individual-skills",
      correlation: {
        records: [
          {
            skillId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
            label: "design-bank",
            evidence: "individual",
            locations: [{ projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/design-bank" }],
          },
        ],
        groups: [
          {
            skillId: "e77eb18e-5c7d-4db8-a2fd-1d941a2aef18",
            state: "unavailable",
            locations: [
              {
                location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/design-bank" },
                read: { status: "unavailable", reason: "denied" },
              },
            ],
            members: [
              {
                location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/design-bank" },
                ref: { kind: "artifact", entry: { kind: "project", id: "project-one" }, artifactId: "inventory-abc" },
                read: { status: "unavailable", reason: "denied" },
              },
            ],
          },
        ],
        candidates: [],
      },
    },
  ],
};

test("observation IPC accepts only managed uses linked to an observed logical location", () => {
  const managedUse = {
    skillId: response.groups[0].correlation.records[0].skillId,
    bindingId: "binding-one",
    location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/design-bank" },
    source: { sourceId: "source-one", packageId: "pstack", artifactPath: "skills/design-bank" },
    baseRevisionId: "d3477a13-4514-4de2-b9c9-f567fbb7e511",
  };
  const linked = { ...response, managedUses: [managedUse] };
  expect(parseObserveSkillCopiesResponse(linked)).toEqual({ ...linked, managedAttention: [] });
  expect(() =>
    parseObserveSkillCopiesResponse({
      ...linked,
      managedUses: [{ ...managedUse, location: { ...managedUse.location, folderPath: ".agents/skills/other" } }],
    }),
  ).toThrow(/exact location/i);
});

test("observation IPC accepts only exact project-bound skill members", () => {
  expect(parseObserveSkillCopiesRequest(request)).toEqual(request);
  expect(() => parseObserveSkillCopiesRequest({ ...request, unexpected: true })).toThrow(/unexpected field/i);
  expect(() => parseObserveSkillCopiesRequest({ ...request, grantHandle: "../other" })).toThrow(/opaque/i);
  expect(() =>
    parseObserveSkillCopiesRequest({
      ...request,
      groups: [
        {
          ...request.groups[0],
          members: [{ ...request.groups[0].members[0], relativePath: "/etc/passwd" }],
        },
      ],
    }),
  ).toThrow(/path/i);
  expect(() =>
    parseObserveSkillCopiesRequest({
      ...request,
      groups: [
        {
          ...request.groups[0],
          members: [{ ...request.groups[0].members[0], relativePath: ".agents/skills/../SKILL.md" }],
        },
      ],
    }),
  ).toThrow(/path/i);
  expect(() =>
    parseObserveSkillCopiesRequest({
      ...request,
      groups: [
        {
          ...request.groups[0],
          members: [
            {
              ...request.groups[0].members[0],
              ref: { ...request.groups[0].members[0].ref, entry: { kind: "project", id: "another-project" } },
            },
          ],
        },
      ],
    }),
  ).toThrow(/outside the project/i);
  expect(() =>
    parseObserveSkillCopiesRequest({
      ...request,
      groups: [request.groups[0], { ...request.groups[0], groupId: "another-group" }],
    }),
  ).toThrow(/unique across groups/i);
});

test("response IPC validates revision, member, and relationship shapes", () => {
  expect(parseObserveSkillCopiesResponse(response)).toEqual({ ...response, managedAttention: [] });
  expect(() =>
    parseObserveSkillCopiesResponse({
      ...response,
      groups: [
        {
          ...response.groups[0],
          correlation: {
            ...response.groups[0].correlation,
            groups: [{ ...response.groups[0].correlation.groups[0], members: [] }],
          },
        },
      ],
    }),
  ).toThrow(/group is invalid/i);
  expect(() =>
    parseObserveSkillCopiesResponse({
      ...response,
      groups: [
        {
          ...response.groups[0],
          correlation: {
            ...response.groups[0].correlation,
            records: [{ ...response.groups[0].correlation.records[0], uses: [{ bindingId: "binding-one" }] }],
          },
        },
      ],
    }),
  ).toThrow(/unexpected field/i);
  expect(() =>
    parseObserveSkillCopiesResponse({
      ...response,
      groups: [
        {
          ...response.groups[0],
          correlation: {
            ...response.groups[0].correlation,
            groups: [
              {
                ...response.groups[0].correlation.groups[0],
                members: [
                  {
                    ...response.groups[0].correlation.groups[0].members[0],
                    read: { status: "unavailable", reason: "partial" },
                  },
                ],
              },
            ],
          },
        },
      ],
    }),
  ).toThrow(/read status/i);
});

test("response IPC retains unavailable records without fabricating members", () => {
  const retained = {
    ...response,
    groups: [],
    retainedSkills: [
      {
        record: response.groups[0].correlation.records[0],
        locations: [
          {
            location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/design-bank" },
            read: { status: "unavailable", reason: "missing" },
          },
        ],
      },
    ],
  };
  expect(parseObserveSkillCopiesResponse(retained)).toEqual({ ...retained, managedAttention: [] });
  expect(() =>
    parseObserveSkillCopiesResponse({
      ...retained,
      retainedSkills: [
        ...retained.retainedSkills,
        {
          record: retained.retainedSkills[0].record,
          locations: retained.retainedSkills[0].locations,
        },
      ],
    }),
  ).toThrow(/overlap|unique/i);
  expect(() =>
    parseObserveSkillCopiesResponse({
      ...retained,
      retainedSkills: [{ ...retained.retainedSkills[0], ref: { kind: "artifact" } }],
    }),
  ).toThrow(/unexpected field/i);
});

test("fresh observation retains missing exact folders and reuses identity on reappearance", async () => {
  type Handler = (event: unknown, request: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  vi.doMock("electron", () => ({
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  }));
  const { registerSkillReconciliationIpcHandlers } = await import("../../src/main/skill-reconciliation/ipc");
  const { SKILL_RECONCILIATION_IPC_CHANNELS } = await import("../../src/shared/skill-reconciliation-ipc");
  const { SKILL_COPY_COMPARISON_CHANNEL, parseSkillCopyComparisonResponse } =
    await import("../../src/shared/skill-copy-comparison-ipc");
  const baseReader = { read: vi.fn(async () => ({ status: "missing" as const })) };
  const temporaryRoot = await mkdtemp(join(tmpdir(), "omni-s04-observation-"));
  const projectRoot = join(temporaryRoot, "registered-project");
  const userDataPath = join(temporaryRoot, "profile");
  await mkdir(projectRoot);
  await mkdir(userDataPath);
  const registeredRoot = await realpath(projectRoot);
  const identity = await stat(registeredRoot);
  let artifacts = [
    observedArtifact("codex-review", ".agents/skills/review/SKILL.md", "codex"),
    observedArtifact("claude-review", ".claude/skills/review/SKILL.md", "claude-code"),
  ];
  let diagnostics: unknown[] = [];
  const observation = () => ({
    subject: { kind: "project" as const, id: "project-one" },
    observedAt: "2026-10-08T10:00:00.000Z",
    inventory: {
      rootHandle: "project-root",
      displayRoot: "registered-project",
      observedAt: "2026-10-08T10:00:00.000Z",
      harnesses: ["codex", "claude-code"],
      artifacts,
      skillOrigins: [],
      packages: [],
      diagnostics,
      gitScopes: [],
    },
  });
  const grant = {
    handle: "grant-one",
    subject: { kind: "project" as const, id: "project-one" },
    root: registeredRoot,
    device: String(identity.dev),
    inode: String(identity.ino),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const registry = {
    get: vi.fn(() => grant),
    observeEntryWithGrant: vi.fn(async () => ({ status: "observed" as const, observation: observation() })),
  };
  registerSkillReconciliationIpcHandlers(() => undefined, registry as never, { userDataPath, baseReader });
  const handler = handlers.get(SKILL_RECONCILIATION_IPC_CHANNELS.observe)!;
  const codexPath = ".agents/skills/review";
  const claudePath = ".claude/skills/review";
  const createCopy = async (folder: string): Promise<void> => {
    await mkdir(join(projectRoot, folder), { recursive: true });
    await writeFile(join(projectRoot, folder, "SKILL.md"), "# Review\n");
    await mkdir(join(projectRoot, folder, "references"), { recursive: true });
    await writeFile(join(projectRoot, folder, "references", "policy.md"), "Keep the exact local copy.\n");
  };
  const memberRequest = (artifactId: string, folder: string) => ({
    ref: { kind: "artifact", entry: { kind: "project", id: "project-one" }, artifactId },
    relativePath: `${folder}/SKILL.md`,
  });
  const requestFor = (members: readonly unknown[]) => ({
    projectId: "project-one",
    grantHandle: "grant-one",
    groups: members.length ? [{ groupId: "individual-skills", members }] : [],
  });

  try {
    await createCopy(codexPath);
    await createCopy(claudePath);
    const first = readyResponse(
      await handler(
        {},
        requestFor([memberRequest("codex-review", codexPath), memberRequest("claude-review", claudePath)]),
      ),
    );
    const skillId = first.groups[0]?.correlation.groups[0]?.skillId;
    const savedReference = first.groups[0]?.correlation.records[0]?.reference;
    expect(skillId).toBeDefined();

    const relationships = (await import("../../src/main/skill-reconciliation/store")).createSkillRelationshipStore(
      join(userDataPath, "omni", "skill-relationships.json"),
    );
    const stored = await relationships.read();
    if (stored.status !== "ready" || !skillId) throw new Error("The observed managed skill record is unavailable.");
    const managedUse = {
      skillId,
      bindingId: "attention-binding",
      location: { projectId: "project-one", harnessId: "codex" as const, folderPath: codexPath },
      source: { sourceId: "source-one", packageId: "packages/tools", artifactPath: "skills/review" },
      baseRevisionId: "d3477a13-4514-4de2-b9c9-f567fbb7e511",
    };
    await relationships.updateUsesExact(stored.state.revision, [
      { skillId, location: managedUse.location, after: managedUse },
    ]);
    const managedObservation = readyResponse(
      await handler(
        {},
        requestFor([memberRequest("codex-review", codexPath), memberRequest("claude-review", claudePath)]),
      ),
    );
    expect(baseReader.read).toHaveBeenCalledWith(managedUse.baseRevisionId, expect.any(Number));
    expect(managedObservation.managedAttention).toContainEqual({
      skillId,
      location: managedUse.location,
      state: "unavailable",
    });

    const comparisonHandler = handlers.get(SKILL_COPY_COMPARISON_CHANNEL)!;
    const storePath = join(userDataPath, "omni", "skill-relationships.json");
    const beforeComparison = await readFile(storePath, "utf8");
    const compared = parseSkillCopyComparisonResponse(
      await comparisonHandler(
        {},
        {
          projectId: "project-one",
          grantHandle: "grant-one",
          skillId,
          a: { projectId: "project-one", harnessId: "codex", folderPath: codexPath },
          b: { projectId: "project-one", harnessId: "claude-code", folderPath: claudePath },
        },
      ),
    );
    expect(compared).toMatchObject({
      status: "ready",
      selectedPath: "SKILL.md",
      presentation: { presentation: "unchanged" },
      evidence: { source: "unknown", base: "unknown" },
    });
    expect(JSON.stringify(compared)).not.toMatch(/fileBytes|sourcePath|basePath/i);
    expect(await readFile(storePath, "utf8")).toBe(beforeComparison);

    await expect(
      comparisonHandler(
        {},
        {
          projectId: "project-one",
          grantHandle: "grant-one",
          skillId,
          a: { projectId: "project-one", harnessId: "codex", folderPath: codexPath },
          b: { projectId: "project-one", harnessId: "claude-code", folderPath: ".claude/skills/other" },
        },
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "membership" });

    await writeFile(join(projectRoot, claudePath, "references", "policy.md"), "Keep this local variation.\n");
    const changed = readyResponse(
      await handler(
        {},
        requestFor([memberRequest("codex-review", codexPath), memberRequest("claude-review", claudePath)]),
      ),
    );
    expect(changed.groups[0].correlation.groups[0]).toMatchObject({ skillId, state: "copy-difference" });
    expect(changed.groups[0].correlation.records[0]?.reference).toEqual(savedReference);

    diagnostics = [{ code: "inaccessible", severity: "warning", location: "claude-code", message: "Unavailable." }];
    await expect(
      handler({}, requestFor([memberRequest("codex-review", codexPath), memberRequest("claude-review", claudePath)])),
    ).resolves.toEqual({ status: "unavailable", reason: "observation" });
    diagnostics = [];

    await rm(join(projectRoot, claudePath), { recursive: true });
    artifacts = [observedArtifact("codex-review", ".agents/skills/review/SKILL.md", "codex")];
    const oneMissing = readyResponse(await handler({}, requestFor([memberRequest("codex-review", codexPath)])));
    expect(oneMissing.groups[0].correlation.groups[0]).toMatchObject({ skillId, state: "unavailable" });
    expect(oneMissing.groups[0].correlation.groups[0].members).toHaveLength(1);
    expect(oneMissing.groups[0].correlation.groups[0].locations).toHaveLength(2);

    await rm(join(projectRoot, codexPath), { recursive: true });
    artifacts = [];
    const allMissing = readyResponse(await handler({}, requestFor([])));
    expect(allMissing).toMatchObject({ groups: [] });
    expect(allMissing.retainedSkills).toHaveLength(1);
    expect(allMissing.retainedSkills[0]).toMatchObject({ record: { skillId }, locations: expect.any(Array) });
    expect(allMissing.retainedSkills[0].locations).toHaveLength(2);
    expect(allMissing.retainedSkills[0].record).not.toHaveProperty("source");

    await createCopy(codexPath);
    await createCopy(claudePath);
    artifacts = [
      observedArtifact("codex-review", ".agents/skills/review/SKILL.md", "codex"),
      observedArtifact("claude-review", ".claude/skills/review/SKILL.md", "claude-code"),
    ];
    const returned = readyResponse(
      await handler(
        {},
        requestFor([memberRequest("codex-review", codexPath), memberRequest("claude-review", claudePath)]),
      ),
    );
    expect(returned.groups[0].correlation.groups[0]).toMatchObject({ skillId, state: "matching-copies" });
    const saved = JSON.parse(await readFile(join(userDataPath, "omni", "skill-relationships.json"), "utf8"));
    expect(saved.skills).toHaveLength(1);
    expect(saved.skills[0].skillId).toBe(skillId);
    expect(saved.skills[0].locations).toHaveLength(2);
    expect(saved.skills[0].reference).toEqual(savedReference);

    const savedBeforeRootReplacement = await readFile(join(userDataPath, "omni", "skill-relationships.json"), "utf8");
    const movedRoot = join(temporaryRoot, "moved-project-root");
    await rename(projectRoot, movedRoot);
    await mkdir(projectRoot);
    await expect(
      handler({}, requestFor([memberRequest("codex-review", codexPath), memberRequest("claude-review", claudePath)])),
    ).resolves.toEqual({ status: "unavailable", reason: "root" });
    expect(await readFile(join(userDataPath, "omni", "skill-relationships.json"), "utf8")).toBe(
      savedBeforeRootReplacement,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function observedArtifact(id: string, relativePath: string, providerId: string) {
  return {
    id,
    physicalIdentity: id,
    projectionPaths: [relativePath],
    kind: "skill",
    relativePath,
    displayPath: relativePath,
    providerIds: [providerId],
    scope: "project",
    confidence: "exact",
    symlinkState: "none",
  };
}

function readyResponse(
  value: unknown,
): Extract<ReturnType<typeof parseObserveSkillCopiesResponse>, { status: "ready" }> {
  const response = parseObserveSkillCopiesResponse(value);
  if (response.status !== "ready") throw new Error("Expected a ready skill observation.");
  return response;
}
