import { basename } from "node:path";

function tokens(command: string): string[] {
  return command.trim().split(/\s+/u).filter(Boolean);
}

function executable(command: string): string {
  return basename(tokens(command)[0] ?? "process").toLowerCase();
}

function hasNumberedVitestWorker(command: string): boolean {
  return /(?:vitest\s+\d+|vitest[^\s]*[-_]worker|worker[-_]?\d+|pool[=: -]workers)/iu.test(command);
}

function scriptAfter(tokensValue: readonly string[], executableName: string): string | undefined {
  const executableIndex = tokensValue.findIndex((token) => token === executableName);
  if (executableIndex < 0) return undefined;
  const nextIndex = tokensValue[executableIndex + 1] === "run" ? executableIndex + 2 : executableIndex + 1;
  return tokensValue[nextIndex];
}

// Node scripts are named after the package that owns the script (`node_modules/<pkg>/…`).
const NODE_PACKAGE_NAMES: readonly (readonly [RegExp, string])[] = [
  [/node_modules\/jest-worker\//u, "Jest workers"],
  [/node_modules\/(?:\.bin\/)?jest(?:\/|$|\s)/u, "Jest"],
  [/node_modules\/(?:\.bin\/)?expo(?:\/|$|\s)/u, "Expo"],
  [/node_modules\/metro/u, "Metro bundler"],
  [/node_modules\/(?:\.bin\/)?next(?:\/|$|\s)/u, "Next.js"],
  [/unified-computer-use/u, "Codex computer use"],
];

function nodeScriptName(command: string): string {
  for (const [pattern, name] of NODE_PACKAGE_NAMES) if (pattern.test(command)) return name;
  const owner = /node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//u.exec(command)?.[1];
  return owner ? `${owner} (Node)` : "Node script";
}

function codexSubcommand(values: readonly string[]): string | undefined {
  return values.slice(1).find((token) => ["exec", "app-server", "sandbox"].includes(token));
}

export function describeProcess(command: string): string {
  const normalized = command.trim();
  const values = tokens(normalized);
  const first = executable(normalized);
  const codexCommand = first === "codex" ? codexSubcommand(values) : undefined;

  if (codexCommand === "exec") return "Codex agent";
  if (codexCommand === "app-server") return "Codex app";
  if (codexCommand === "sandbox") return "Codex sandbox";
  if (/mcp-server|(?:^|[\s/])mcp(?:\s|$)/iu.test(normalized)) return "MCP server";
  if (
    first === "claude" ||
    first === "claude-code" ||
    /\/claude\.app\/Contents\/MacOS\/claude(?:\s|$)/iu.test(normalized)
  ) {
    return "Claude Code session";
  }
  if (/(?:^|\s)(?:zsh|bash)(?:\s|$)/iu.test(normalized) || /(?:^|\s)sh\s+-c(?:\s|$)/iu.test(normalized)) {
    return "shell";
  }
  if (first === "git") return "Git";
  if (first === "electron" && /omni-desktop|Omni\.app|out\/main/iu.test(normalized)) return "Electron (Omni)";
  if (first === "electron-vite" || /(?:^|[\s/])electron-vite(?:\s|$)/iu.test(normalized)) return "electron-vite";
  if (hasNumberedVitestWorker(normalized)) return "vitest workers";
  if (/(?:^|[\s/(])vitest(?:[\s)/]|$)/iu.test(normalized)) return "vitest";
  if (/(?:^|[\s/])vite(?:\s|$)/iu.test(normalized)) return "Vite dev server";
  if (/(?:^|[\s/])tsc(?:\s|$)/iu.test(normalized)) return "TypeScript check";
  if (/(?:^|[\s/])eslint(?:\s|$)/iu.test(normalized)) return "ESLint";
  if (first === "node" && values[1] === "-e") return "Node script";
  if (first === "node" && values.length > 1) return nodeScriptName(normalized);
  if (first === "pnpm") {
    const script = scriptAfter(values, "pnpm");
    return script ? `pnpm ${script}` : "pnpm";
  }
  if (first === "npm") {
    const script = scriptAfter(values, "npm");
    return script ? `npm ${script}` : "npm";
  }
  if (first === "codex") return "Codex";
  return basename(values[0] ?? "process");
}
