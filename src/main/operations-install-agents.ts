import { agentUpdateConflict } from "./agent-update-safety";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentHarness } from "../shared/agents-ipc";
import type {
  ApplyOperationResponse,
  OperationAction,
  OperationPlan,
  PreviewMarketplaceResponse,
} from "../shared/operations-ipc";
import { parseInstallAgentsRequest } from "../shared/operations-install-agents-ipc";
import { createOperationStore, type OperationStore } from "./operation-store";
import {
  guardScriptPath,
  agentHomeDir,
  harnessLabel,
  harnessPaths,
  inspectAgentHarnesses,
  mcpCliPath,
  type AgentHarnessInspection,
} from "./agent-harnesses";
import { bundleRoot, readBundle, type OmniSkillBundle } from "./omni-skills-bundle";
import { planRegisterMcp, unifiedDiff } from "./operations-register-mcp";
import { guardEntryState, guardHookEntry, setGuardEntry } from "./hook-entry";
import { createAgentFileOperations } from "./agent-file-operation";
import { hashContent } from "./marketplace-manifests";
import { isMissing, readOptionalText } from "./fs-optional";

type PlannedAction = OperationAction & Readonly<{ absolutePath: string; content?: string; beforeContent?: string }>;
type InstallOptions = Readonly<{
  userDataPath: string;
  operationStore?: OperationStore;
  homeDir?: string;
  cliPath?: string;
  guardPath?: string;
  bundle?: OmniSkillBundle;
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  now?: () => number;
  updateVersion?: string;
}>;
function hash(value: string | Uint8Array): string {
  return hashContent(value);
}
function view(action: PlannedAction): OperationAction {
  const { absolutePath: _path, content: _content, beforeContent: _before, ...result } = action;
  return result;
}

function skillAction(
  homeDir: string,
  harness: AgentHarness,
  skillName: string,
  relativePath: string,
  content: string,
  beforeContent?: string,
): PlannedAction {
  const paths = harnessPaths(harness);
  const rootRelative = `${paths.skills}/${skillName}/${relativePath}`;
  const path = join(homeDir, rootRelative);
  return {
    kind: "write-file",
    relativePath: rootRelative,
    byteLength: Buffer.byteLength(content),
    ...(beforeContent === undefined ? {} : { beforeHash: hash(beforeContent), beforeContent }),
    ...(beforeContent === undefined
      ? {}
      : {
          diff: unifiedDiff(beforeContent, content, `${paths.skillsDisplay}/${skillName}/${relativePath}`),
        }),
    absolutePath: path,
    content,
  };
}

function deleteSkillAction(
  homeDir: string,
  harness: AgentHarness,
  skillName: string,
  path: string,
  content: string,
): PlannedAction {
  const relativePath = `${harnessPaths(harness).skills}/${skillName}/${path}`;
  const absolutePath = join(homeDir, relativePath);
  return {
    kind: "delete-file",
    relativePath,
    beforeHash: hash(content),
    beforeContent: content,
    absolutePath,
  };
}

function skillActions(
  homeDir: string,
  inspection: AgentHarnessInspection,
  bundle: OmniSkillBundleItem,
  force: boolean,
): PlannedAction[] {
  const detail = inspection.skillDetails.find((item) => item.name === bundle.name)!;
  const actions: PlannedAction[] = [];
  if (detail.state === "missing") {
    for (const file of bundle.files)
      actions.push(skillAction(homeDir, inspection.harness, bundle.name, file.relativePath, file.content));
    return actions;
  }
  if (detail.state !== "outdated" && !(force && detail.state === "installed")) return actions;
  const expected = new Map(bundle.files.map((file) => [file.relativePath, file.content]));
  for (const [path, content] of expected)
    if (force || detail.contents.get(path) !== content)
      actions.push(skillAction(homeDir, inspection.harness, bundle.name, path, content, detail.contents.get(path)));
  for (const path of detail.files)
    if (!expected.has(path))
      actions.push(deleteSkillAction(homeDir, inspection.harness, bundle.name, path, detail.contents.get(path)!));
  return actions;
}

type OmniSkillBundleItem = OmniSkillBundle[number];

async function directoryExists(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isDirectory() && !details.isSymbolicLink();
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function foreignDiagnostic(inspection: AgentHarnessInspection): string | undefined {
  const foreign = inspection.skillDetails.find((skill) => skill.state === "foreign");
  if (!foreign) return undefined;
  const paths = harnessPaths(inspection.harness);
  return `The ${foreign.name} folder in the ${harnessLabel(inspection.harness)} skills belongs to another skill (name: ${foreign.foreignName ?? "unknown"}). Rename or remove it, then retry.`;
}

export function createInstallAgentsOperations(options: InstallOptions): Readonly<{
  preview(raw: unknown): Promise<PreviewMarketplaceResponse>;
  apply(raw: unknown): Promise<ApplyOperationResponse | undefined>;
}> {
  const homeDir = agentHomeDir(options);
  const store = options.operationStore ?? createOperationStore(join(options.userDataPath, "omni", "operations.json"));
  const now = options.now ?? Date.now;
  const files = createAgentFileOperations({ userDataPath: options.userDataPath, homeDir, operationStore: store, now });
  const preview = async (raw: unknown): Promise<PreviewMarketplaceResponse> => {
    const request = parseInstallAgentsRequest(raw);
    const cliPath = mcpCliPath(options);
    const guardPath = guardScriptPath(options);
    const bundle = options.bundle ?? (await readBundle(bundleRoot(options)));
    const inspections = await inspectAgentHarnesses({
      homeDir,
      harnesses: request.harnesses,
      bundle,
      userDataPath: options.userDataPath,
      cliPath,
      ...(options.isPackaged === undefined ? {} : { isPackaged: options.isPackaged }),
      ...(options.resourcesPath ? { resourcesPath: options.resourcesPath } : {}),
      ...(options.appPath ? { appPath: options.appPath } : {}),
    });
    for (const harness of request.harnesses) {
      const inspection = inspections.find((item) => item.harness === harness)!;
      if (options.updateVersion && !inspection.registered)
        return {
          status: "blocked",
          reason: "agent-disconnected",
          diagnostic: `${harnessLabel(harness)} is no longer connected. Connect it in Settings before updating.`,
        };
      if (!inspection.detected)
        return {
          status: "blocked",
          reason: "harness-not-detected",
          diagnostic: `${harnessLabel(harness)} was not found on this Mac (its ${harnessPaths(harness).home} folder is missing).`,
        };
      if (options.updateVersion) {
        const loaded = await store.read();
        if (loaded.status !== "ready")
          return { status: "blocked", reason: "operations-unavailable", diagnostic: loaded.diagnostic };
        const conflict = agentUpdateConflict(inspection, loaded.receipts);
        if (conflict) return { status: "blocked", reason: "agent-file-modified", diagnostic: conflict };
      }
      const foreign = foreignDiagnostic(inspection);
      if (foreign) return { status: "blocked", reason: "skill-foreign", diagnostic: foreign };
    }
    try {
      await readFile(cliPath);
    } catch {
      return {
        status: "blocked",
        reason: "mcp-build-missing",
        diagnostic: "Build the MCP server first (pnpm --filter @omni/mcp build)",
      };
    }
    const actions: PlannedAction[] = [];
    const summaries: NonNullable<OperationPlan["harnesses"]>[number][] = [];
    for (const harness of request.harnesses) {
      const inspection = inspections.find((item) => item.harness === harness)!;
      const paths = harnessPaths(harness);
      const before = await readOptionalText(join(homeDir, paths.settings));
      let mcp: ReturnType<typeof planRegisterMcp>;
      try {
        mcp = planRegisterMcp({
          harness,
          action: "enable",
          homeDir,
          cliPath,
          userDataPath: options.userDataPath,
          ...(before === undefined ? {} : { before }),
        });
      } catch (error: unknown) {
        return {
          status: "blocked",
          reason: "settings-invalid",
          diagnostic: error instanceof Error ? error.message : "Settings could not be read safely.",
        };
      }
      const harnessActions: PlannedAction[] = [];
      if (mcp.action) harnessActions.push(mcp.action);
      else if (request.force && before !== undefined)
        harnessActions.push({
          kind: "write-file",
          relativePath: paths.settings,
          absolutePath: join(homeDir, paths.settings),
          content: before,
          beforeHash: hash(before),
          byteLength: Buffer.byteLength(before),
        });
      const guardBefore = await readOptionalText(join(homeDir, paths.guardSettings));
      const guardRegistration = guardEntryState(guardBefore, harness, guardPath);
      let guardAction: PlannedAction | undefined;
      if (!guardRegistration.current || request.force) {
        const guardAfter = setGuardEntry(guardBefore, guardHookEntry(harness, guardPath));
        if (guardAfter !== undefined && (guardAfter !== guardBefore || request.force)) {
          guardAction = {
            kind: "write-file",
            relativePath: paths.guardSettings,
            byteLength: Buffer.byteLength(guardAfter),
            ...(guardBefore === undefined ? {} : { beforeHash: hash(guardBefore) }),
            diff: unifiedDiff(guardBefore, guardAfter, paths.guardSettingsDisplay),
            absolutePath: join(homeDir, paths.guardSettings),
            content: guardAfter,
          };
          harnessActions.push(guardAction);
        }
      }
      const guardSummary: "add" | "keep" | "update" = guardRegistration.registered
        ? guardRegistration.current
          ? "keep"
          : "update"
        : "add";
      const skillNames = { add: [] as string[], update: [] as string[], keep: [] as string[] };
      for (const skill of bundle) {
        const state = inspection.skills.find((item) => item.name === skill.name)?.state;
        if (state === "missing") skillNames.add.push(skill.name);
        else if (state === "outdated" || (request.force && state === "installed")) skillNames.update.push(skill.name);
        else if (state === "installed") skillNames.keep.push(skill.name);
      }
      const skillRoot = join(homeDir, paths.skills);
      if (skillNames.add.length && !(await directoryExists(skillRoot)))
        harnessActions.push({
          kind: "create-directory",
          relativePath: paths.skills,
          absolutePath: skillRoot,
        });
      for (const skillName of skillNames.add)
        harnessActions.push({
          kind: "create-directory",
          relativePath: `${paths.skills}/${skillName}`,
          absolutePath: join(skillRoot, skillName),
        });
      for (const skill of bundle)
        harnessActions.push(...skillActions(homeDir, inspection, skill, request.force === true));
      actions.push(...harnessActions);
      summaries.push({
        harness,
        status:
          mcp.action || guardAction || skillNames.add.length || skillNames.update.length ? "changes" : "nothing-to-do",
        mcp: mcp.action ? "add" : "keep",
        skills: skillNames,
        guard: guardSummary,
      });
    }
    const plan: OperationPlan = {
      planId: randomUUID(),
      kind: "install-agents",
      displayTarget: request.harnesses
        .map((harness) => `${harnessPaths(harness).settingsDisplay} · ${harnessPaths(harness).skillsDisplay}`)
        .join(" · "),
      actions: actions.map(view),
      git: { mode: "not-a-repository", warnings: [] },
      harnesses: summaries,
    };
    files.remember(plan, actions, cliPath, {
      ...(request.harnesses.length === 1 ? { harness: request.harnesses[0] } : {}),
      agentSetup: {
        harnesses: request.harnesses,
        action: options.updateVersion ? "update" : request.force ? "reinstall" : "connect",
        ...(options.updateVersion ? { version: options.updateVersion } : {}),
      },
      ...(options.updateVersion ? { provenance: { approval: "automatic" } } : {}),
    });
    return { status: "ready", plan };
  };
  return { preview, apply: files.apply };
}
