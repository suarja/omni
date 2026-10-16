import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  createGitScope,
  createInventoryDiagnostic,
  type GitScope,
  type InventoryDiagnostic,
} from "../../domain/inventory";

const DEFAULT_TIMEOUT_MS = 5_000;
const SAFE_ENVIRONMENT_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP"] as const;
const GIT_COMMON_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
] as const;

export type GitCommandRequest = Readonly<{
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}>;

export type GitCommandResult = Readonly<{
  stdout: string;
  stderr?: string;
}>;

export type GitProcessOptions = Readonly<{
  cwd: string;
  env: NodeJS.ProcessEnv;
  encoding: "utf8";
  maxBuffer: number;
  shell: false;
  timeout: number;
  windowsHide: boolean;
}>;

export type GitProcessExecutor = (
  file: string,
  args: readonly string[],
  options: GitProcessOptions,
) => Promise<GitCommandResult>;

export type GitPathResolver = (path: string) => Promise<string>;

export type GitCommandRunner = (request: GitCommandRequest) => Promise<GitCommandResult>;

export type LocalGitScopeRequest = Readonly<{
  path: string;
  relativeRoot: string;
}>;

export type LocalGitScanRequest = Readonly<{
  approvedRoot: string;
  scopes?: readonly LocalGitScopeRequest[];
  timeoutMs?: number;
}>;

export type LocalGitEvidence = Readonly<{
  scopes: readonly GitScope[];
  diagnostics: readonly InventoryDiagnostic[];
}>;

export interface InventoryGitPort {
  collect(request: LocalGitScanRequest): Promise<LocalGitEvidence>;
}

function createSafeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }

  return {
    ...environment,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function execFileExecutor(
  file: string,
  args: readonly string[],
  options: GitProcessOptions,
): Promise<GitCommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, [...args], options, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        reject(error);
        return;
      }

      resolvePromise({ stdout, stderr });
    });
  });
}

export function createGitCommandRunner(executor: GitProcessExecutor = execFileExecutor): GitCommandRunner {
  return (request) =>
    executor("git", request.args, {
      cwd: request.cwd,
      env: request.env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: request.timeoutMs,
      windowsHide: true,
    });
}

const runGitCommand = createGitCommandRunner();

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function safeLocation(relativeRoot: string): string {
  return normalizeRelativeRoot(relativeRoot) ?? "scope";
}

function gitDiagnostic(relativeRoot: string): InventoryDiagnostic {
  return createInventoryDiagnostic({
    location: safeLocation(relativeRoot),
    code: "git-unavailable",
    severity: "warning",
    message: "Git evidence could not be observed for this explicit scope.",
  });
}

function commandArgs(command: readonly string[]): string[] {
  return [...GIT_COMMON_ARGS, ...command];
}

function readSingleLine(stdout: string): string | undefined {
  const value = stdout.trim();
  return value && !value.includes("\n") && !value.includes("\r") ? value : undefined;
}

function readHead(stdout: string): string | undefined {
  const value = readSingleLine(stdout);
  return value && /^[0-9a-f]{4,64}$/i.test(value) ? value : undefined;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isAbsolutePathLike(value: string): boolean {
  const normalized = stripWrappingQuotes(value).replaceAll("\\", "/");
  return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
}

function normalizeRelativeRoot(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = stripWrappingQuotes(value).replaceAll("\\", "/");
  if (!normalized || isAbsolutePathLike(normalized)) return undefined;
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    return undefined;
  }
  return normalized;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const distance = relative(root, candidate);
  return distance === "" || (distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance));
}

async function canonicalizePath(path: string, pathResolver: GitPathResolver): Promise<string | undefined> {
  if (!isAbsolutePathLike(path) || !isAbsolute(path)) return undefined;
  try {
    const canonical = await pathResolver(resolve(path));
    return isAbsolute(canonical) ? resolve(canonical) : undefined;
  } catch {
    return undefined;
  }
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; killed?: unknown };
  return candidate.code === "ETIMEDOUT" || candidate.killed === true;
}

function scopeId(relativeRoot: string): string {
  return `git-${relativeRoot.replaceAll("\\", "/")}`;
}

function nextScopeId(relativeRoot: string, usedIds: Set<string>): string {
  const base = scopeId(relativeRoot);
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function createScope(
  id: string,
  relativeRoot: string,
  head: string | undefined,
  dirty: boolean | "unknown",
  branch?: string,
): GitScope {
  return createGitScope({
    id,
    relativeRoot,
    ...(head ? { head } : {}),
    dirty,
    ...(branch ? { branch } : {}),
  });
}

export async function collectLocalGitEvidence(
  request: LocalGitScanRequest,
  runner: GitCommandRunner = runGitCommand,
  pathResolver: GitPathResolver = realpath,
): Promise<LocalGitEvidence> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Git inventory timeout must be a positive integer.");
  }

  const scopes = (
    request.scopes?.length ? request.scopes : [{ path: resolve(request.approvedRoot), relativeRoot: "project" }]
  )
    .slice()
    .sort((left, right) => {
      const rootOrder = compareCodeUnits(String(left.relativeRoot), String(right.relativeRoot));
      return rootOrder || compareCodeUnits(left.path, right.path);
    });
  const canonicalApprovedRoot = await canonicalizePath(request.approvedRoot, pathResolver);
  const preparedScopes = await Promise.all(
    scopes.map(async (scope) => {
      const normalizedRelativeRoot = normalizeRelativeRoot(scope.relativeRoot);
      const relativeRoot = normalizedRelativeRoot ?? "scope";
      const canonicalPath = canonicalApprovedRoot ? await canonicalizePath(scope.path, pathResolver) : undefined;
      return {
        canonicalPath:
          canonicalApprovedRoot && canonicalPath && isWithinRoot(canonicalApprovedRoot, canonicalPath)
            ? canonicalPath
            : undefined,
        path: scope.path,
        relativeRoot,
        relativeRootInvalid: normalizedRelativeRoot === undefined,
      };
    }),
  );
  const environment = createSafeEnvironment();
  const observedScopes: GitScope[] = [];
  const diagnostics: InventoryDiagnostic[] = [];
  const usedScopeIds = new Set<string>();

  for (const scope of preparedScopes) {
    const id = nextScopeId(scope.relativeRoot, usedScopeIds);
    let diagnosticAdded = false;
    if (scope.relativeRootInvalid) {
      diagnostics.push(gitDiagnostic(scope.relativeRoot));
      diagnosticAdded = true;
    }
    if (!scope.canonicalPath) {
      try {
        observedScopes.push(createScope(id, scope.relativeRoot, undefined, "unknown"));
      } catch {
        // Invalid redaction labels remain diagnostic-only.
      }
      if (!diagnosticAdded) diagnostics.push(gitDiagnostic(scope.relativeRoot));
      continue;
    }
    const run = (command: readonly string[]) =>
      runner({
        args: commandArgs(command),
        cwd: scope.canonicalPath as string,
        env: environment,
        timeoutMs,
      });

    try {
      const rootResult = await run(["rev-parse", "--show-toplevel"]);
      const root = readSingleLine(rootResult.stdout);
      const canonicalGitRoot = root ? await canonicalizePath(root, pathResolver) : undefined;
      if (!canonicalApprovedRoot || !canonicalGitRoot || !isWithinRoot(canonicalApprovedRoot, canonicalGitRoot)) {
        throw new Error("Git root evidence was outside the approved root.");
      }
    } catch (error: unknown) {
      if (!isTimeoutError(error) || scope.relativeRootInvalid) {
        try {
          observedScopes.push(createScope(id, scope.relativeRoot, undefined, "unknown"));
        } catch {
          // The approved caller supplies redacted relative roots; invalid values remain diagnostic-only.
        }
      }
      if (!diagnosticAdded) diagnostics.push(gitDiagnostic(scope.relativeRoot));
      continue;
    }

    let head: string | undefined;
    let branch: string | undefined;
    let dirty: boolean | "unknown" = "unknown";

    try {
      head = readHead((await run(["rev-parse", "--verify", "HEAD"])).stdout);
      if (!head) diagnostics.push(gitDiagnostic(scope.relativeRoot));
    } catch {
      diagnostics.push(gitDiagnostic(scope.relativeRoot));
    }

    try {
      dirty = (await run(["status", "--porcelain=v1", "-uno"])).stdout.trim().length > 0;
    } catch {
      diagnostics.push(gitDiagnostic(scope.relativeRoot));
    }

    try {
      const value = readSingleLine((await run(["rev-parse", "--abbrev-ref", "HEAD"])).stdout);
      if (value !== "HEAD" && value && /^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/u.test(value) && !value.includes(".."))
        branch = value;
    } catch {
      // Detached or unborn HEAD can still expose the independently observed status.
    }

    try {
      observedScopes.push(createScope(id, scope.relativeRoot, head, dirty, branch));
    } catch {
      diagnostics.push(gitDiagnostic(scope.relativeRoot));
    }
  }

  return {
    scopes: observedScopes.sort((left, right) => compareCodeUnits(left.id, right.id)),
    diagnostics: diagnostics.sort((left, right) => {
      const locationOrder = compareCodeUnits(left.location, right.location);
      return locationOrder || compareCodeUnits(left.code, right.code);
    }),
  };
}

export function createLocalGitAdapter(runner: GitCommandRunner = runGitCommand): InventoryGitPort {
  return {
    collect(request) {
      return collectLocalGitEvidence(request, runner);
    },
  };
}
