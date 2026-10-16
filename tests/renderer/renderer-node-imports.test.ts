import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guards the renderer's module graph against re-introducing a Node built-in (the bug this test
 * was added for: `src/domain/identity.ts` importing `node:crypto`, which Vite externalizes in the
 * browser and crashes the renderer with "Cannot access node:crypto.createHash in client code" —
 * a white screen that Vitest's Node environment never catches). It also guards against the
 * renderer reaching into the main-process-only layers (`src/main`, `src/adapters`,
 * `src/application`), which are not meant to run in the browser either.
 *
 * The walk starts at `src/renderer/renderer.tsx` and follows relative import/export-from
 * specifiers transitively. There are no `@/`-style path aliases configured in this project
 * (checked in `tsconfig.json` and `vite.config.ts` — neither declares `paths` or `resolve.alias`),
 * so only relative (`./`, `../`) specifiers need resolving; bare specifiers are npm packages and
 * are out of scope. `import type` / `export type` statements (whole-statement or fully inline,
 * e.g. `import { type A, type B } from "./x"`) are skipped, since they carry no runtime import and
 * are erased by the bundler.
 */

const SRC_ROOT = resolve(__dirname, "../../src");
const ENTRY = resolve(SRC_ROOT, "renderer/renderer.tsx");

const NODE_BUILTIN_NAMES = new Set(["fs", "path", "crypto", "os", "child_process", "url", "util", "stream", "events"]);

const FORBIDDEN_TOP_DIRS = new Set(["main", "adapters", "application"]);

type Violation = Readonly<{ file: string; specifier: string; reason: string }>;

/** Whether an import/export "clause" (the part between the keyword and `from`) carries no runtime value. */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ") || trimmed === "type") return true;
  const named = trimmed.match(/^\{([^}]*)\}$/);
  if (!named) return false;
  const names = named[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((entry) => entry.startsWith("type "));
}

/**
 * Extracts every specifier this source runtime-imports: `import ... from "spec"`,
 * `export ... from "spec"`, bare `import "spec"`, and `import("spec")`. Type-only statements are
 * excluded. A regex walker is sufficient here — this file never needs a real TS parser.
 */
function collectValueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const fromRe = /\b(import|export)\s+([^;]+?)\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(fromRe)) {
    const clause = match[2]!;
    if (isTypeOnlyClause(clause)) continue;
    specifiers.push(match[3]!);
  }
  const sideEffectRe = /(?:^|[\s;{])import\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(sideEffectRe)) specifiers.push(match[1]!);
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(dynamicRe)) specifiers.push(match[1]!);
  return specifiers;
}

function classifySpecifier(specifier: string): "node-builtin" | "relative" | "external" {
  if (specifier.startsWith("node:")) return "node-builtin";
  if (specifier.startsWith(".") || specifier.startsWith("/")) return "relative";
  const topSegment = specifier.split("/")[0]!;
  return NODE_BUILTIN_NAMES.has(topSegment) ? "node-builtin" : "external";
}

/** Resolves a relative specifier to a concrete `.ts`/`.tsx` file on disk, or undefined for a non-code asset (css, json, ...). */
function resolveRelativeModule(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")];
  for (const candidate of candidates) {
    if (
      (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) &&
      existsSync(candidate) &&
      lstatSync(candidate).isFile()
    ) {
      return candidate;
    }
  }
  return undefined;
}

function topDirOf(absolutePath: string): string | undefined {
  const rel = relative(SRC_ROOT, absolutePath);
  if (rel.startsWith("..")) return undefined;
  return rel.split(sep)[0];
}

/** Runs the transitive walk from `entry`, returning every disallowed import found. */
function collectRendererGraphViolations(entry: string): Violation[] {
  const violations: Violation[] = [];
  const visited = new Set<string>();
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, "utf8");
    const fileLabel = relative(SRC_ROOT, file);

    for (const specifier of collectValueImportSpecifiers(source)) {
      const kind = classifySpecifier(specifier);
      if (kind === "node-builtin") {
        violations.push({
          file: fileLabel,
          specifier,
          reason: "imports a Node built-in module, which the browser-side renderer cannot access",
        });
        continue;
      }
      if (kind === "external") continue;

      const resolved = resolveRelativeModule(file, specifier);
      if (!resolved) continue; // non-code asset (css, json, ...) or unresolved — nothing to check

      const topDir = topDirOf(resolved);
      if (topDir && FORBIDDEN_TOP_DIRS.has(topDir)) {
        violations.push({
          file: fileLabel,
          specifier,
          reason: `reaches into src/${topDir}, which is main-process-only and must never load in the renderer`,
        });
        continue;
      }
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }

  return violations;
}

describe("renderer module graph", () => {
  it("never reaches a Node built-in import or a main/adapters/application module from renderer.tsx", () => {
    const violations = collectRendererGraphViolations(ENTRY);
    if (violations.length > 0) {
      const details = violations.map((v) => `  ${v.file} imports "${v.specifier}" — ${v.reason}`).join("\n");
      throw new Error(`Renderer module graph reaches disallowed imports:\n${details}`);
    }
  });

  it("does not reach src/domain/records.ts, which uses node:crypto", () => {
    const visited = new Set<string>();
    const queue: string[] = [ENTRY];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      for (const specifier of collectValueImportSpecifiers(source)) {
        if (classifySpecifier(specifier) !== "relative") continue;
        const resolved = resolveRelativeModule(file, specifier);
        if (resolved && !visited.has(resolved)) queue.push(resolved);
      }
    }
    const reachedFiles = [...visited].map((file) => relative(SRC_ROOT, file));
    expect(reachedFiles).not.toContain("domain/records.ts");
  });
});

describe("import specifier detection (unit)", () => {
  it("flags a node: import — the exact shape that caused the white-screen regression in identity.ts", () => {
    const source = 'import { createHash } from "node:crypto";\n\nexport const x = createHash;\n';
    const specifiers = collectValueImportSpecifiers(source);
    expect(specifiers).toContain("node:crypto");
    expect(classifySpecifier("node:crypto")).toBe("node-builtin");
  });

  it("flags a bare Node builtin specifier without the node: prefix", () => {
    expect(classifySpecifier("fs")).toBe("node-builtin");
    expect(classifySpecifier("fs/promises")).toBe("node-builtin");
    expect(classifySpecifier("path")).toBe("node-builtin");
  });

  it("does not flag an unrelated bare package or a relative import as a Node builtin", () => {
    expect(classifySpecifier("react")).toBe("external");
    expect(classifySpecifier("./identity")).toBe("relative");
    expect(classifySpecifier("../../domain/identity")).toBe("relative");
  });

  it("skips whole-statement and fully-inline type-only imports, but follows a mixed import", () => {
    const source = [
      'import type { A } from "./a";',
      'export type { B } from "./b";',
      'import { type C, type D } from "./c";',
      'import { type C2, E } from "./d";',
      'import F from "./e";',
      'import "./styles.css";',
    ].join("\n");
    expect(collectValueImportSpecifiers(source)).toEqual(["./d", "./e", "./styles.css"]);
  });
});
