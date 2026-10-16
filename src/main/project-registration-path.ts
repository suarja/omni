import { execFile } from "node:child_process";
import { access, constants, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

export type RegistrationPathPolicy = Readonly<{
  homeDir?: string;
  systemRoots?: readonly string[];
  temporaryRoots?: readonly string[];
}>;
export type RegistrationPathResult =
  | Readonly<{ status: "resolved"; root: string; cwd?: string; gitRoot: boolean; device: string; inode: string }>
  | Readonly<{ status: "blocked"; code: string; reason: string }>;
const run = promisify(execFile);
function contains(root: string, path: string): boolean {
  const distance = relative(root, path);
  return distance === "" || (!distance.startsWith("..") && !isAbsolute(distance));
}
function protectedPath(path: string, policy: RegistrationPathPolicy): boolean {
  const home = resolve(policy.homeDir ?? homedir());
  const system = policy.systemRoots ?? [
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/dev",
    "/proc",
    "/sys",
    "/var",
    "/private/var",
  ];
  const temporary = policy.temporaryRoots ?? [tmpdir(), "/tmp", "/private/tmp"];
  return (
    path === "/" ||
    path === "/Users" ||
    path === "/private" ||
    path === home ||
    [...system, ...temporary].some((root) => contains(resolve(root), path))
  );
}
function block(code: string, reason: string): RegistrationPathResult {
  return { status: "blocked", code, reason };
}
async function directory(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error("Not a folder.");
  await access(canonical, constants.R_OK | constants.X_OK);
  return canonical;
}
async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const result = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: 5000,
      maxBuffer: 16384,
      env: {
        ...process.env,
        LC_ALL: "C",
        LANG: "C",
        LANGUAGE: "C",
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
      },
    });
    return result.stdout.trim();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      String(error.stderr).includes("not a git repository")
    )
      return undefined;
    throw error;
  }
}

export async function resolveRegistrationPath(
  callerCwd: string | undefined,
  explicitPath: string | undefined,
  sourceRoots: readonly string[],
  policy: RegistrationPathPolicy = {},
): Promise<RegistrationPathResult> {
  const cwd = callerCwd && isAbsolute(callerCwd) ? resolve(callerCwd) : undefined;
  if (!cwd && (explicitPath === undefined || !isAbsolute(explicitPath)))
    return block(
      "project-cwd-unavailable",
      "The calling agent's absolute working directory is required for a relative path or no path. Pass an absolute project path or retry from the project session.",
    );
  const target =
    explicitPath === undefined ? cwd! : isAbsolute(explicitPath) ? resolve(explicitPath) : resolve(cwd!, explicitPath);
  if (protectedPath(target, policy))
    return block(
      "project-path-protected",
      "Home, filesystem, system and temporary folders cannot be registered. Choose a project folder.",
    );
  try {
    if ((await directory(target)) !== target)
      return block(
        "project-symlink-escape",
        "The project folder resolves elsewhere through a symlink. Retry from the actual folder.",
      );
    const top = await gitRoot(target);
    const root = top ? resolve(top) : target;
    if (protectedPath(root, policy))
      return block(
        "project-path-protected",
        "The Git root is a protected folder. Retry from a project outside that root.",
      );
    if ((await directory(root)) !== root)
      return block("project-symlink-escape", "The project root resolves elsewhere through a symlink.");
    for (const source of sourceRoots) {
      const canonical = await realpath(source).catch(() => resolve(source));
      if (contains(canonical, root) || contains(root, canonical))
        return block(
          "project-marketplace-overlap",
          "The project overlaps a registered marketplace source. Choose a separate project folder.",
        );
    }
    const identity = await stat(root);
    return {
      status: "resolved",
      ...(cwd ? { cwd } : {}),
      root,
      gitRoot: Boolean(top),
      device: String(identity.dev),
      inode: String(identity.ino),
    };
  } catch {
    return block(
      "project-folder-unavailable",
      "The project folder is missing, unreadable or its Git root cannot be determined. Check access and retry.",
    );
  }
}
