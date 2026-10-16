// resources/guard/omni-guard.mjs ships as plain JavaScript (no dependency, run directly by
// Claude Code and Codex outside this app's own module graph) and resources/ is not part of the
// TypeScript program, so importing it directly needs one small ambient wildcard declaration.
// TypeScript only honors ambient module declarations for relative specifiers when they are a
// wildcard pattern (a literal relative path is always resolved against the real file first), so
// this is a generic `*.mjs` fallback rather than one typed to this file's own exports.
declare module "*.mjs" {
  export type GuardDecision =
    Readonly<{ decision: "deny" | "warn"; reason: string }> | Readonly<{ decision: "allow"; internalError?: string }>;
  export function decide(input: unknown, config?: unknown): GuardDecision;
  export const DENY_REASON: string;
}
