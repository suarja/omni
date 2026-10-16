#!/usr/bin/env node
// Omni's PreToolUse guard (Brief B1). Shipped as a resource, materialized by the app into
// <userData>/omni/guard/omni-guard.mjs (see src/main/omni-guard-runtime.ts) so the hook command
// path never changes across app updates. Plain ESM, no dependency: this script is executed by
// Claude Code and Codex themselves, outside the app's own module graph.
//
// `decide(input, config)` is a pure function (no I/O) used directly by unit tests. The
// stdin/stdout/guard.json wrapper below only runs when this file is executed directly.
//
// Honest limit (not enforced in code): this guard sees harness tool calls and shell commands
// that *name* a managed path. It is not an OS sandbox — a script that writes indirectly
// (through another process, a symlink dance, etc.) passes.

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DENY_REASON =
  "Managed by Omni: use the omni_* tools (omni_preview_update_skill, omni_preview_capture, omni_preview_assign).";

// Static managed-path globs (item 2). `~` entries are expanded against the real home directory
// at decide() time; the rest match anywhere a matching path segment occurs.
const STATIC_GLOBS = [
  "**/.claude/skills/**",
  "**/.agents/skills/**",
  "~/.claude/skills/**",
  "~/.codex/skills/**",
  "**/.claude-plugin/**",
  "**/.codex-plugin/**",
  "**/omni.plugin.json",
  "**/omni.marketplace.json",
  "**/.agents/plugins/marketplace.json",
];

const LIBERAL_WRITE_COMMANDS = new Set(["rm", "mv", "touch", "mkdir", "ln", "chmod", "truncate", "tee"]);
const DEST_ONLY_COMMANDS = new Set(["cp", "rsync", "install"]);
const INPLACE_EDIT_COMMANDS = new Set(["sed", "perl"]);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Translates a glob containing only "**" wildcards (our only shape) into an anchored RegExp.
function globToRegExp(glob) {
  const parts = glob.split("**").map(escapeRegExp);
  return new RegExp(`^${parts.join(".*")}$`, "u");
}

function staticPatterns() {
  const home = homedir();
  return STATIC_GLOBS.map((glob) => (glob.startsWith("~/") ? `${home}/${glob.slice(2)}` : glob)).map(globToRegExp);
}

// Expands a leading ~, $HOME or ${HOME} against the real home directory (item 2: shell tokens
// commonly use the environment-variable spellings, not just the tilde).
function expandHome(path) {
  if (path === "~" || path === "$HOME" || path === "${HOME}") return homedir();
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  if (path.startsWith("$HOME/")) return `${homedir()}/${path.slice(6)}`;
  if (path.startsWith("${HOME}/")) return `${homedir()}/${path.slice(8)}`;
  return path;
}

// realpath of the nearest existing ancestor, with the remaining (not-yet-existing) segments
// appended literally — so a target reached through a filesystem symlink (macOS's /tmp →
// /private/tmp is the common case) still compares equal to a canonical root from guard.json.
// Never throws: an unresolvable path (permissions, a root that disappeared, …) is returned as-is.
function canonicalize(path) {
  let current = path;
  const remaining = [];
  for (let guard = 0; guard < 64; guard += 1) {
    try {
      const real = normalizeSlashes(realpathSync(current));
      return remaining.length ? `${real}/${remaining.join("/")}` : real;
    } catch {
      const index = current.lastIndexOf("/");
      if (index <= 0) return path;
      remaining.unshift(current.slice(index + 1));
      current = current.slice(0, index);
    }
  }
  return path;
}

function normalizeSlashes(path) {
  return path.replaceAll("\\", "/");
}

function resolvePath(rawPath, cwd) {
  const expanded = expandHome(String(rawPath));
  const base = expandHome(typeof cwd === "string" && cwd ? cwd : "/");
  const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded);
  return normalizeSlashes(absolute);
}

// A minimal, quote-aware split of a shell command line into top-level statements on ; && || |
// and newlines. Not a full shell parser (see the honest-limit note above): good enough to keep
// write-risk detection from crossing quoted strings.
function splitSegments(command) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((char === "&" || char === "|") && command[i + 1] === char) {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (char === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) segments.push(current);
  return segments;
}

function tokenize(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function basenameOf(token) {
  const normalized = normalizeSlashes(token);
  return normalized.split("/").at(-1) ?? normalized;
}

// Every string collected here is a *candidate* write destination, resolved to an absolute path
// against `base` — the hook's cwd, updated in place by a `cd <dir>` segment so the segments that
// follow it in the same command resolve relative paths correctly (item 3). Candidates that are
// not real paths (a sed pattern, a flag value, ...) are harmless: they will simply never match a
// managed glob downstream.
function shellWriteTargets(command, cwd) {
  const targets = [];
  let base = cwd;
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (/^\d*[<>]&(?:\d+|-)$/u.test(token)) continue;
      if (/^\d*[<>]&$/u.test(token) && /^(?:\d+|-)$/u.test(tokens[i + 1] ?? "")) {
        i += 1;
        continue;
      }
      if (/^\d*(?:>>?|&>>?)$/u.test(token)) {
        if (tokens[i + 1]) targets.push(resolvePath(tokens[i + 1], base));
        continue;
      }
      const attached = /^\d*(?:>>?|&>>?)(.+)$/u.exec(token);
      if (attached && attached[1]) targets.push(resolvePath(attached[1], base));
    }
    const commandName = basenameOf(tokens[0]);
    const rest = tokens.slice(1);
    const positional = rest.filter((token) => !token.startsWith("-"));
    if (commandName === "cd") {
      if (positional[0]) base = resolvePath(positional[0], base);
      continue;
    }
    if (LIBERAL_WRITE_COMMANDS.has(commandName)) targets.push(...positional.map((path) => resolvePath(path, base)));
    else if (DEST_ONLY_COMMANDS.has(commandName)) {
      if (positional.length) targets.push(resolvePath(positional[positional.length - 1], base));
    } else if (
      INPLACE_EDIT_COMMANDS.has(commandName) &&
      rest.some((token) => token === "-i" || token.startsWith("-i"))
    )
      targets.push(...positional.map((path) => resolvePath(path, base)));
    else if (commandName === "git" && (rest[0] === "checkout" || rest[0] === "restore"))
      targets.push(
        ...positional
          .slice(1)
          .filter((token) => token !== "--")
          .map((path) => resolvePath(path, base)),
      );
  }
  return targets;
}

// Every path named in an apply_patch's *** Add File: / *** Update File: / *** Delete File: /
// *** Move to: lines.
function applyPatchTargets(patch, cwd) {
  const targets = [];
  const expression = /^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+)$/gmu;
  for (const match of patch.matchAll(expression)) if (match[1]) targets.push(match[1].trim());
  return targets.map((path) => resolvePath(path, cwd));
}

function extractWriteTargets(toolName, toolInput, cwd) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    return typeof input.file_path === "string" ? [resolvePath(input.file_path, cwd)] : [];
  }
  if (toolName === "NotebookEdit") {
    return typeof input.notebook_path === "string" ? [resolvePath(input.notebook_path, cwd)] : [];
  }
  if (toolName === "apply_patch") {
    return typeof input.command === "string" ? applyPatchTargets(input.command, cwd) : [];
  }
  if (toolName === "Bash") {
    const raw = input.command;
    const command = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join(" ") : undefined;
    if (typeof command !== "string") return [];
    const targets = shellWriteTargets(command, cwd);
    // A `apply_patch <<'EOF' ... EOF` heredoc splits into lines that `shellWriteTargets`'s
    // segment/command parsing does not recognize (item 4): when the command carries a patch,
    // also run the dedicated apply_patch extraction over the whole text.
    if (command.includes("*** Begin Patch") || command.includes("apply_patch"))
      targets.push(...applyPatchTargets(command, cwd));
    return targets;
  }
  return [];
}

function normalizeConfig(config) {
  const marketplaceRoots =
    config && Array.isArray(config.marketplaceRoots)
      ? config.marketplaceRoots.filter((root) => typeof root === "string" && root)
      : [];
  const warnProjects =
    config && Array.isArray(config.warnProjects)
      ? config.warnProjects.filter((root) => typeof root === "string" && root)
      : [];
  return { marketplaceRoots, warnProjects };
}

function underRoot(path, root) {
  const normalizedRoot = normalizeSlashes(root).replace(/\/$/u, "");
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

// The static patterns match the literal path (they are about path *shape*, e.g. a `.claude/
// skills` segment, which a symlink does not change); guard.json's roots are canonicalized
// already at write time (item 5), so only the target is canonicalized here, lazily — realpath is
// a syscall, skipped entirely when no root is configured to compare against.
function isManaged(path, cfg, patterns) {
  if (patterns.some((pattern) => pattern.test(path))) return true;
  if (cfg.marketplaceRoots.length === 0) return false;
  const canonical = canonicalize(path);
  return cfg.marketplaceRoots.some((root) => underRoot(canonical, root));
}

function isWarnOnly(path, cfg) {
  if (cfg.warnProjects.length === 0) return false;
  const canonical = canonicalize(path);
  return cfg.warnProjects.some((root) => underRoot(canonical, root));
}

function decideChecked(input, config) {
  if (input === null || typeof input !== "object") throw new Error("Malformed hook input.");
  const toolName = input.tool_name;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const targets = extractWriteTargets(toolName, input.tool_input, cwd);
  if (targets.length === 0) return { decision: "allow" };
  const cfg = normalizeConfig(config);
  const patterns = staticPatterns();
  const managed = targets.filter((path) => isManaged(path, cfg, patterns));
  if (managed.length === 0) return { decision: "allow" };
  return managed.every((path) => isWarnOnly(path, cfg))
    ? { decision: "warn", reason: DENY_REASON }
    : { decision: "deny", reason: DENY_REASON };
}

/**
 * Pure decision function used directly by unit tests. Never throws: any internal error (a
 * malformed `config`, an unexpected `input` shape, ...) is reported as `internalError` and the
 * decision always falls back to "allow" — a broken guard must never block the user's agent.
 */
export function decide(input, config) {
  try {
    return decideChecked(input, config);
  } catch (error) {
    return { decision: "allow", internalError: error instanceof Error ? error.message : String(error) };
  }
}

async function readStdin() {
  return new Promise((resolvePromise) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolvePromise(data));
    process.stdin.on("error", () => resolvePromise(data));
  });
}

function readConfig(scriptPath) {
  const configPath = resolve(scriptPath, "..", "guard.json");
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // Missing or malformed guard.json: no marketplace root, no warn project. The static
    // patterns still apply (item 1).
    return undefined;
  }
}

async function main() {
  const raw = await readStdin();
  let input = {};
  let parseError;
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const config = readConfig(fileURLToPath(import.meta.url));
  const result = decide(input, config);
  if (result.internalError) process.stderr.write(`omni-guard: ${result.internalError}\n`);
  else if (parseError) process.stderr.write(`omni-guard: malformed hook input (${parseError})\n`);
  if (result.decision === "deny") {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
      })}\n`,
    );
  } else if (result.decision === "warn") {
    process.stdout.write(`${JSON.stringify({ systemMessage: result.reason })}\n`);
  }
  process.exit(0);
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch(() => {
    // decide()/main() never throw on their own; this only guards a truly unexpected failure
    // (e.g. stdout write error) — still never block the agent.
    process.exit(0);
  });
}
