import { join } from "node:path";
import { homedir } from "node:os";

import { activityHarnessAdapters, type ActivityEvidenceIo } from "../adapters/activity";
import { claudeTranscriptDirectory } from "../adapters/activity/claude-code";
import { createActivityEvidenceIo } from "./activity-evidence-io";
import { absolutePath, projectForPath, type ActivityProjectRoot } from "./activity-paths";
import { attachProcessCwds, attributeProcesses, findActivityRoots, rootProcessRecord } from "./activity-processes";
import { scanWorktrees, type ClaudeWorktreeSession, type RegisteredProjectRoot } from "./activity-worktrees";
import type { ActivitySnapshot, AgentSession } from "../shared/activity-ipc";
import { createLocalJsonRegistryStore } from "../adapters/registry/local-json";
import { createPlatform, type Platform } from "./platform";

export type Clock = () => number;
export type ProjectRootsReader = () => Promise<readonly RegisteredProjectRoot[]>;
export type ActivitySnapshotOptions = Readonly<{
  userDataPath: string;
  now?: Clock;
  platform?: Platform;
  evidenceIo?: ActivityEvidenceIo;
  projectRoots?: ProjectRootsReader;
  omniPid: number;
  jobSessions?: () => readonly AgentSession[];
}>;

export async function registeredProjects(userDataPath: string): Promise<RegisteredProjectRoot[]> {
  const store = createLocalJsonRegistryStore(join(userDataPath, "omni", "project-source-registry.json"));
  const loaded = await store.read();
  if (loaded.status !== "ready") return [];
  return loaded.state.projects
    .filter((project) => project.archivedAt === undefined)
    .map((project) => ({
      projectId: project.id,
      projectName: project.displayName,
      root: project.locator.canonicalPath,
    }));
}

async function simulationProjects(
  userDataPath: string,
  evidenceIo: ActivityEvidenceIo,
): Promise<RegisteredProjectRoot[]> {
  const root = join(userDataPath, "omni", "simulations");
  const entries = await evidenceIo.readDir(root);
  return entries.map((projectId) => ({
    projectId: `simulation-${projectId}`,
    projectName: projectId,
    root: join(root, projectId, "repo"),
  }));
}

export async function allProjectRoots(
  userDataPath: string,
  reader: ProjectRootsReader,
  evidenceIo: ActivityEvidenceIo = createActivityEvidenceIo(homedir()),
): Promise<RegisteredProjectRoot[]> {
  return [...(await reader()), ...(await simulationProjects(userDataPath, evidenceIo))];
}

function sessionProjects(
  sessions: readonly AgentSession[],
  projects: readonly ActivityProjectRoot[],
  homeDir: string,
): AgentSession[] {
  return sessions.map((session) => {
    const project = projectForPath(absolutePath(session.cwd, homeDir), projects);
    return {
      ...session,
      ...(project
        ? { projectId: project.projectId, ...(project.projectName ? { projectName: project.projectName } : {}) }
        : {}),
    };
  });
}

function claudeWorktreeSessions(sessions: readonly AgentSession[], homeDir: string): ClaudeWorktreeSession[] {
  return sessions
    .filter((session) => session.harness === "claude-code")
    .map((session) => {
      const cwd = absolutePath(session.cwd, homeDir);
      const sessionId = session.id.slice("claude-code:".length);
      return {
        sessionId,
        cwd,
        transcriptDirectory: claudeTranscriptDirectory(homeDir, cwd),
      };
    });
}

function aggregateSessions(
  sessions: readonly AgentSession[],
  processes: readonly ReturnType<typeof attributeProcesses>[number][],
  worktrees: readonly ActivitySnapshot["worktrees"][number][],
): AgentSession[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const process of processes) {
    if (!process.sessionId) continue;
    const session = byId.get(process.sessionId);
    if (!session) continue;
    const processPids = [...new Set([...session.processPids, process.pid])].sort((left, right) => left - right);
    const flags = [...new Set([...session.flags, ...process.flags])];
    byId.set(process.sessionId, {
      ...session,
      processPids,
      totals: {
        cpuPercent: Math.round((session.totals.cpuPercent + process.cpuPercent) * 10) / 10,
        rssMb: Math.round((session.totals.rssMb + process.rssMb) * 10) / 10,
      },
      flags,
    });
  }
  for (const worktree of worktrees) {
    if (!worktree.sessionId) continue;
    const session = byId.get(worktree.sessionId);
    if (!session) continue;
    byId.set(worktree.sessionId, {
      ...session,
      worktreeIds: [...new Set([...session.worktreeIds, `${worktree.projectId}/${worktree.id}`])],
    });
  }
  return sessions.map((session) => byId.get(session.id) ?? session);
}

export async function buildActivitySnapshot(options: ActivitySnapshotOptions): Promise<ActivitySnapshot> {
  const now = options.now ?? Date.now;
  const platform = options.platform ?? createPlatform();
  const io = options.evidenceIo ?? createActivityEvidenceIo(homedir());
  const rawProcesses = [...(await platform.processes.list())];
  const roots = findActivityRoots(rawProcesses, options.omniPid);
  const cwdByPid = await platform.processes.workingDirectories(roots.map((process) => process.pid));
  const processesWithCwds = attachProcessCwds(rawProcesses, cwdByPid);
  const livePids = new Set(processesWithCwds.map((process) => process.pid));
  const evidenceIo: ActivityEvidenceIo = {
    ...io,
    isProcessAlive: io.isProcessAlive ?? ((pid) => livePids.has(pid)),
  };
  const rootRecords = roots.map((process) =>
    rootProcessRecord(
      {
        ...process,
        cwd: cwdByPid.get(process.pid),
      },
      now(),
    ),
  );
  const sessions = (
    await Promise.all(
      activityHarnessAdapters.map((adapter) =>
        adapter.readSessions(
          rootRecords.filter((root) => adapter.isRoot(root.command)),
          evidenceIo,
        ),
      ),
    )
  ).flat();
  const projectReader = options.projectRoots ?? (() => registeredProjects(options.userDataPath));
  const projects = await allProjectRoots(options.userDataPath, projectReader, evidenceIo);
  const attributed = attributeProcesses(processesWithCwds, options.omniPid, {
    rootSessionIds: new Map(
      roots.flatMap((root) => {
        const adapter = activityHarnessAdapters.find((candidate) => candidate.isRoot(root.command));
        const session =
          adapter?.entrypoint(root.command) === "app" ? undefined : sessions.find((item) => item.pid === root.pid);
        return session ? [[root.pid, session.id] as const] : [];
      }),
    ),
    conversationSessionIds: new Map(
      sessions.flatMap((session) =>
        session.entrypoint === "app" ? session.processPids.map((pid) => [pid, session.id] as const) : [],
      ),
    ),
    conversationNames: new Map(
      sessions.flatMap((session) =>
        session.entrypoint === "app" ? session.processPids.map((pid) => [pid, session.name] as const) : [],
      ),
    ),
  });
  const worktrees = await scanWorktrees(projects, {
    now: now(),
    evidenceIo,
    claudeSessions: claudeWorktreeSessions(sessions, evidenceIo.homeDir),
  });
  const enrichedSessions = sessionProjects(
    [...sessions, ...(options.jobSessions ? options.jobSessions() : [])],
    projects,
    evidenceIo.homeDir,
  );
  return {
    sessions: aggregateSessions(enrichedSessions, attributed, worktrees),
    processes: attributed,
    worktrees,
    platformSupported: platform.supported,
  };
}

export function createActivitySnapshotReader(options: ActivitySnapshotOptions): () => Promise<ActivitySnapshot> {
  let pending: Promise<ActivitySnapshot> | undefined;
  return () => {
    if (pending) return pending;
    const current = buildActivitySnapshot(options);
    pending = current;
    void current
      .finally(() => {
        if (pending === current) pending = undefined;
      })
      .catch(() => undefined);
    return current;
  };
}
