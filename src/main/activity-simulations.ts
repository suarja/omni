import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

import { safeGitArgs } from "./safe-git-args";

const execFile = promisify(nodeExecFile);

export async function createRunawaySimulation(): Promise<number> {
  const child = spawn(
    process.execPath,
    ["-e", "process.title='omni-sim-runaway'; setInterval(()=>{ let x=0; for(let i=0;i<1e7;i++) x+=i; },0)"],
    {
      detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OMNI_SIMULATION: "1" },
      stdio: "ignore",
    },
  );
  child.unref();
  await new Promise<void>((resolvePromise, reject) => {
    child.once("spawn", () => resolvePromise());
    child.once("error", reject);
  });
  return child.pid!;
}

export async function createStaleSimulation(userDataPath: string, projectId: string): Promise<string> {
  const root = join(userDataPath, "omni", "simulations", projectId, "repo");
  await mkdir(root, { recursive: true });
  const initialized = await execFile("git", safeGitArgs(["rev-parse", "--show-toplevel"]), {
    cwd: root,
    shell: false,
    windowsHide: true,
  }).then(
    () => true,
    () => false,
  );
  if (!initialized) {
    await execFile("git", safeGitArgs(["init", "-q"]), { cwd: root, shell: false, windowsHide: true });
    await execFile("git", safeGitArgs(["config", "user.email", "omni@local"]), {
      cwd: root,
      shell: false,
      windowsHide: true,
    });
    await execFile("git", safeGitArgs(["config", "user.name", "Omni"]), {
      cwd: root,
      shell: false,
      windowsHide: true,
    });
    await writeFile(join(root, "simulation.txt"), "simulation\n", "utf8");
    await execFile("git", safeGitArgs(["add", "simulation.txt"]), {
      cwd: root,
      shell: false,
      windowsHide: true,
    });
    const staleDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await execFile("git", safeGitArgs(["commit", "-q", "-m", "simulation"]), {
      cwd: root,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_AUTHOR_DATE: staleDate, GIT_COMMITTER_DATE: staleDate },
    });
  }
  const worktreeDirectory = join(root, ".worktrees");
  await mkdir(worktreeDirectory, { recursive: true });
  const entries = await readdir(worktreeDirectory).catch(() => []);
  const number =
    entries.reduce((largest, entry) => {
      const match = /^wt-(\d+)$/u.exec(entry);
      return match ? Math.max(largest, Number(match[1])) : largest;
    }, 0) + 1;
  const path = join(worktreeDirectory, `wt-${number}`);
  await execFile("git", safeGitArgs(["worktree", "add", "-q", "-b", `sim/${number}`, path]), {
    cwd: root,
    shell: false,
    windowsHide: true,
  });
  return relative(userDataPath, path).replaceAll(sep, "/");
}
