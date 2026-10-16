import type { SkillIntent } from "../../src/shared/skill-management-ipc";
import { act, useState } from "react";
import type { Route } from "../../src/renderer/navigation";
import { useRouteHistory } from "../../src/renderer/use-route-history";
import type { Root } from "react-dom/client";
import { vi } from "vitest";
import { ResourceCanvas } from "../../src/renderer/canvas/ResourceCanvas";
import { I18nProvider } from "../../src/renderer/i18n";
import type { ExternalComparison, ExternalSourceDetails, ExternalUse } from "../../src/shared/external-library-ipc";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES } from "../../src/shared/settings-ipc";
import { projectApi, projectId, projectSnapshot, skillRow, skills } from "./project-view-fixture";
import type { OperationReceipt } from "../../src/shared/operations-ipc";

const head = "a".repeat(40),
  lock = "b".repeat(64),
  copyHash = "c".repeat(64),
  sourceHash = "d".repeat(64);
export function useFixture(id: string, state: ExternalUse["state"]): ExternalUse {
  return {
    id,
    sourceId: "mattpocock/skills",
    projectId,
    projectName: "notes-app",
    skillKey: id,
    folderPath: `.agents/skills/${id}`,
    skillPath: `skills/${id}`,
    lockHash: lock,
    copyHash: state === "modified" ? copyHash : lock,
    sourceHash,
    state,
    sourceChanged: state !== "up-to-date",
    base: { status: "unknown", reason: "Recovered on demand" },
    ...(state === "removed"
      ? { removal: { commit: head, date: "2026-10-12T09:12:00.000Z", subject: "Renamed into better-tool" } }
      : {}),
  };
}
export function detailsFixture(): ExternalSourceDetails {
  const uses = [
    useFixture("grill-me", "modified"),
    useFixture("old-tool", "removed"),
    useFixture("update-tool", "update"),
  ];
  return {
    source: {
      id: "mattpocock/skills",
      name: "mattpocock/skills",
      repo: "mattpocock/skills",
      kind: "github",
      arrival: "detected",
      readCopy: "~/omni/external-sources/mattpocock__skills",
      head: { commit: head, date: "2026-10-12T09:12:00.000Z" },
      lastCheckAt: "2026-10-12T09:12:00.000Z",
      licence: "MIT",
      skillCount: 4,
      unusedSkills: 2,
      counts: { "up-to-date": 0, modified: 1, update: 1, removed: 1, unknown: 0 },
      projects: [{ id: projectId, name: "notes-app" }],
    },
    skills: [
      {
        path: "skills/grill-me",
        name: "grill-me",
        description: "Interview a plan",
        licence: "MIT",
        useIds: ["grill-me"],
        lastChangeAt: "2026-10-12T09:12:00.000Z",
      },
      {
        path: "skills/update-tool",
        name: "update-tool",
        description: "Updated tool",
        licence: "MIT",
        useIds: ["update-tool"],
      },
      { path: "skills/fresh-tool", name: "fresh-tool", description: "New source skill", licence: "MIT", useIds: [] },
      { path: "skills/local-tool", name: "local-tool", description: "Name already used", licence: "MIT", useIds: [] },
    ],
    uses,
  };
}
export function comparisonFixture(useId: string): ExternalComparison {
  const version = (text: string) => ({ text, hash: lock, bytes: text.length, binary: false });
  return {
    status: "ready",
    useId,
    base: { status: "found", commit: head, scanned: 1 },
    files: [
      {
        path: "SKILL.md",
        classification: useId.startsWith("grill") ? "conflict" : "storefront-only",
        base: version("base\n"),
        copy: version("mine\n"),
        source: version("upstream\n"),
      },
      {
        path: "source.txt",
        classification: "storefront-only",
        base: version("old\n"),
        copy: version("old\n"),
        source: version("new\n"),
      },
      {
        path: "local.txt",
        classification: "workshop-changed",
        base: version("base\n"),
        copy: version("local\n"),
        source: version("base\n"),
      },
    ],
  };
}
export type FixtureOptions = Readonly<{
  mode?: "auto" | "ask";
  offline?: boolean;
  missingBase?: boolean;
  unused?: boolean;
  failure?: boolean;
  allFailed?: boolean;
  project?: boolean;
  twoProjects?: boolean;
  modifiedRemoved?: boolean;
  language?: "en" | "fr";
  macSkillSource?: boolean;
  archivedProject?: boolean;
}>;
export function createFixture(options: FixtureOptions = {}) {
  const primary = detailsFixture();
  if (options.modifiedRemoved) primary.uses[1]!.copyHash = copyHash;
  if (options.twoProjects) {
    const otherProject = projectSnapshot.registry.projects.find((project) => project.ref.id !== projectId)!;
    primary.uses.push({
      ...useFixture("grill-other", "modified"),
      skillKey: "grill-me",
      skillPath: "skills/grill-me",
      projectId: otherProject.ref.id,
      projectName: otherProject.displayName,
    });
    primary.skills[0]!.useIds.push("grill-other");
  }
  if (options.offline) {
    primary.source!.lastError = { type: "offline", message: "Network unavailable" };
    primary.uses = primary.uses.map((use) => ({ ...use, state: "unknown", diagnostic: "Network unavailable" }));
    primary.source!.counts = { "up-to-date": 0, modified: 0, update: 0, removed: 0, unknown: 3 };
  }
  if (options.failure)
    primary.uses[2]!.lastAutomaticFailure = {
      sourceHead: head,
      copyHash: lock,
      failedAt: "2026-10-12T09:12:00.000Z",
      reason: "Copy changed during apply",
    };
  const unused: ExternalSourceDetails = {
    ...structuredClone(primary),
    source: {
      ...primary.source!,
      id: "fixture/unused",
      name: "fixture/unused",
      repo: "fixture/unused",
      projects: [],
      skillCount: 1,
      unusedSkills: 1,
      counts: { "up-to-date": 0, modified: 0, update: 0, removed: 0, unknown: 0 },
    },
    skills: [
      { path: "skills/old-tool", name: "old-tool", description: "Same-name replacement", useIds: [], licence: "MIT" },
    ],
    uses: [],
  };
  const details = options.unused ? [unused] : [primary, unused];
  const settings = {
    schemaVersion: 8 as const,
    git: { commitChanges: true },
    agents: {
      approval: { personalMarketplace: "conversation" as const, projects: "omni" as const },
      guard: { warnProjectIds: [] },
    },
    ai: DEFAULT_AI_SETTINGS,
    features: DEFAULT_FEATURES,
    externalLibrary: { updates: options.mode ?? "auto" },
  };
  const failedHistory: OperationReceipt = {
    operationId: "auto-failed",
    kind: "skill-management",
    status: "failed",
    displayTarget: "Update external skills · mattpocock/skills",
    appliedAt: "2026-10-12T09:12:00.000Z",
    actions: [],
    registered: null,
    git: { mode: "disabled" },
    provenance: { approval: "automatic", reason: "automatic" },
    children: [],
  };
  let previewNumber = 0;
  const api = {
    ...projectApi(),
    previewSkillOperation: vi.fn(async (_request: { intent: SkillIntent }) => ({
      status: "ready" as const,
      intentId: `intent-${++previewNumber}`,
      planId: "plan-1",
      effectFingerprint: "f".repeat(64),
      scope: { targets: [] },
      steps: [],
    })),
    listExternalSources: vi.fn(async () => ({
      sources: details.map((item) => item.source!),
      checking: false,
      diagnostics: options.offline ? [primary.source!.lastError!] : [],
      lastPass: {
        startedAt: "2026-10-12T09:11:00.000Z",
        finishedAt: "2026-10-12T09:12:00.000Z",
        result: "success" as const,
        errors: 0,
        diagnostics: [],
        ...(options.mode !== "ask"
          ? { updates: [{ sourceId: primary.source!.id, copiesUpdated: 42, failedTargets: 0 }] }
          : {}),
      },
    })),
    readExternalSource: vi.fn(async ({ sourceId }: { sourceId: string }) =>
      details.find((item) => item.source!.id === sourceId)!,
    ),
    compareExternalUse: vi.fn(async ({ useId }: { useId: string }): Promise<ExternalComparison> =>
      options.missingBase
        ? { status: "unavailable", useId, base: { status: "not-found", scanned: 300, bounded: true }, files: [] }
        : comparisonFixture(useId),
    ),
    listExternalSourcesOnMac: vi.fn(async () => ({
      status: "ready" as const,
      marketplaces: [
        { id: "marketing-skills", repo: "mattpocock/skills" },
        { id: "commands-only", repo: "fixture/commands" },
        ...(options.macSkillSource ? [{ id: "source-with-skills", repo: "fixture/mac-skills" }] : []),
      ],
    })),
    discoverExternalSource: vi.fn(async ({ repository }: { repository: string }) => {
      const known = details.find((item) => item.source!.id === repository);
      if (known) return { status: "ready" as const, ...known, source: known.source!, marketplaceMatches: [] };
      const commands = repository === "fixture/commands";
      return {
        status: "ready" as const,
        source: {
          ...unused.source!,
          id: repository,
          name: repository,
          repo: repository,
          skillCount: commands ? 0 : 1,
          unusedSkills: commands ? 0 : 1,
        },
        skills: commands ? [] : unused.skills,
        uses: [],
        marketplaceMatches: [],
      };
    }),
    prepareExternalSkillImport: vi.fn(async ({ skillPath }: { sourceId: string; skillPath: string }) => ({
      kind: "source" as const,
      id: "external-copy",
      grantHandle: "external-grant",
      relativePath: skillPath,
    })),
    readExternalSkillDocument: vi.fn(async ({ skillPath }: { sourceId: string; skillPath: string }) => ({
      status: "read" as const,
      content: `# Actual content\n${skillPath}/SKILL.md`,
      byteLength: 24,
      truncated: false,
    })),
    openExternalSourceRepository: vi.fn(async () => ({ status: "opened" as const })),
    previewOperation: vi.fn(async () => ({
      status: "ready" as const,
      plan: {
        planId: "import-plan",
        kind: "import-artifact" as const,
        displayTarget: "External skill",
        actions: [],
        git: { mode: "disabled" as const, warnings: [] },
      },
    })),
    addExternalSource: vi.fn(async ({ repository }: { repository: string }) => {
      const added = {
        ...structuredClone(unused),
        source: { ...unused.source!, id: repository, name: repository, repo: repository },
      };
      if (!details.some((item) => item.source!.id === repository)) details.push(added);
      return { status: "added" as const, ...added, marketplaceMatches: [] };
    }),
    checkExternalLibrary: vi.fn(async () => ({
      startedAt: "2026-10-12T09:11:00.000Z",
      finishedAt: "2026-10-12T09:12:00.000Z",
      result: "success" as const,
      errors: 0,
      diagnostics: [],
    })),
    acknowledgeRemovedExternalUse: vi.fn(async () => {
      primary.uses = primary.uses.map((use) => (use.state === "removed" ? { ...use, acknowledged: true } : use));
      return primary;
    }),
    getSettings: vi.fn(async () => settings),
    setSettings: vi.fn(async (request: { externalLibrary?: { updates: "auto" | "ask" } }) => {
      if (request.externalLibrary) settings.externalLibrary = request.externalLibrary;
      return settings;
    }),
    listOperations: vi.fn(async () => ({
      status: "ready" as const,
      receipts: options.allFailed ? [failedHistory] : [],
    })),
    readProjectSkills: vi.fn(async (id: string) => ({
      ...structuredClone(skills),
      projectId: id,
      skills: [
        ...skills.skills.filter((row) => row.name !== "grill-me"),
        ...primary.uses
          .filter((use) => use.projectId === id)
          .map((use) => ({
            ...skillRow(use.skillKey, "external"),
            state:
              use.state === "removed"
                ? ("removed-upstream" as const)
                : use.state === "modified"
                  ? ("modified-here" as const)
                  : use.state === "update"
                    ? ("update-available" as const)
                    : ("unknown" as const),
            agents: {
              "claude-code": { state: "installed" as const, folderPath: `.claude/skills/${use.skillKey}` },
              codex: { state: "installed" as const, folderPath: `.agents/skills/${use.skillKey}` },
            },
          })),
      ],
    })),
    applySkillOperation: vi.fn(async () => ({
      intentId: "intent-1",
      operationId: "operation-1",
      status: options.allFailed ? ("failed" as const) : ("applied" as const),
      source: { status: "unchanged" as const },
      targets: [],
      receiptIds: [],
      issues: options.allFailed
        ? [{ code: "failed", message: "No target applied", recoveryAction: "refresh" as const }]
        : [],
      recoveryAvailable: false,
    })),
  };
  return { api, details, settings, primary };
}
export async function renderExternal(
  root: Root,
  options: FixtureOptions = {},
): Promise<ReturnType<typeof createFixture>> {
  const fixture = createFixture(options);
  const grant = vi.fn(async () => "grant");
  const snapshot = options.archivedProject
    ? {
        ...projectSnapshot,
        registry: {
          ...projectSnapshot.registry,
          projects: projectSnapshot.registry.projects.map((project) =>
            project.ref.id === projectId ? { ...project, archivedAt: "2026-10-12T00:00:00.000Z" } : project,
          ),
        },
      }
    : projectSnapshot;
  function Navigation() {
    const [route, navigate] = useState<Extract<Route, { screen: "resource-canvas" }>>({
      screen: "resource-canvas",
      context: options.project ? { kind: "entry", entry: { kind: "project", id: projectId } } : { kind: "workspace" },
    });
    const history = useRouteHistory(route, (next) => {
      if (next.screen === "resource-canvas") navigate(next);
    });
    return (
      <ResourceCanvas
        {...route}
        api={fixture.api}
        snapshot={snapshot}
        onEnsureGrant={grant}
        onRefresh={vi.fn()}
        onNavigate={(next) => {
          if (next.screen === "resource-canvas") navigate(next);
        }}
        onBack={history.canGoBack ? history.onBack : undefined}
        onForward={history.canGoForward ? history.onForward : undefined}
        onNavigateDestination={vi.fn()}
      />
    );
  }
  await act(async () =>
    root.render(
      <I18nProvider initialLanguage={options.language ?? "fr"}>
        <Navigation />
      </I18nProvider>,
    ),
  );
  return fixture;
}
export async function click(container: ParentNode, label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Button ${label} was not found.`);
  await act(async () => button.click());
}
export async function openLibrary(container: ParentNode): Promise<void> {
  const node = container.querySelector<HTMLElement>('[data-kind="external-source"] .canvas-node');
  if (!node) throw new Error("Library node was not found.");
  await act(async () => node.click());
}

export async function openSourcePage(container: ParentNode, sourceId = "mattpocock/skills"): Promise<void> {
  await click(container, sourceId);
}
export async function openExternalSkill(container: ParentNode, name: string): Promise<void> {
  const node = [...container.querySelectorAll<HTMLElement>("[data-external-skill]")].find(
    (node) => node.dataset.externalSkill === name,
  );
  if (!node) throw new Error(`Skill ${name} was not found.`);
  await act(async () => node.querySelector<HTMLButtonElement>(".canvas-node")!.click());
}
export async function openExternalInstall(container: ParentNode, name: string): Promise<void> {
  await openExternalSkill(container, name);
  const target = container.querySelector('[data-testid="external-skill-sheet"]')!;
  const project = target.querySelector<HTMLInputElement>("input:not(:disabled)")!;
  await act(async () => project.click());
  const button = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.startsWith("Installer dans ") && !button.disabled,
  )!;
  await act(async () => button.click());
}
