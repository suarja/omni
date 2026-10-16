import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectStack, type DetectStackInput, type ManifestInput } from "../../src/domain/stack-profile";
import { MANIFEST_BASENAMES } from "../../src/domain/stack-tags";

const NOW = "2026-09-14T12:00:00.000Z";
const HASH = "a".repeat(64);

const FIXTURES_ROOT = join(import.meta.dirname, "../fixtures/stack");
const SKIP_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".expo",
  "coverage",
  "vendor",
  "target",
]);
const HARNESS_HIDDEN_ALLOW = new Set([".claude", ".codex", ".cursor", ".github"]);
const HARNESS_MARKERS = new Set(["CLAUDE.md", "AGENTS.md", ".claude", ".codex", ".cursor"]);
const MAX_DEPTH = 4;

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

type FixtureAccumulator = {
  presentPaths: string[];
  extensionCounts: Record<string, number>;
  harnessFiles: string[];
  manifests: ManifestInput[];
};

/**
 * A test-only mirror of the bounds `src/main/stack-profile-ipc.ts` applies to the inventory
 * port (depth ≤ 4, skip list, manifest allowlist) so these fixtures exercise `detectStack` the
 * same way a real project tree would, without going through Electron IPC or a grant.
 */
function walkFixture(root: string, path: string, acc: FixtureAccumulator): void {
  const entries = readdirSync(join(root, path)).sort();
  for (const name of entries) {
    if (name.startsWith(".") && !HARNESS_HIDDEN_ALLOW.has(name)) continue;
    if (SKIP_NAMES.has(name)) continue;
    const entryPath = path ? `${path}/${name}` : name;
    const stats = statSync(join(root, entryPath));
    acc.presentPaths.push(entryPath);
    if (HARNESS_MARKERS.has(name)) acc.harnessFiles.push(name);
    if (stats.isDirectory()) {
      if (entryPath.split("/").length <= MAX_DEPTH) walkFixture(root, entryPath, acc);
      continue;
    }
    const extension = extensionOf(name);
    if (extension) acc.extensionCounts[extension] = (acc.extensionCounts[extension] ?? 0) + 1;
    if (MANIFEST_BASENAMES.has(name)) {
      acc.manifests.push({ path: entryPath, content: readFileSync(join(root, entryPath), "utf8") });
    }
  }
}

function loadFixture(name: string): DetectStackInput {
  const acc: FixtureAccumulator = { presentPaths: [], extensionCounts: {}, harnessFiles: [], manifests: [] };
  walkFixture(join(FIXTURES_ROOT, name), "", acc);
  return { ...acc, computedAt: NOW, treeHash: HASH };
}

describe("detectStack — rule kinds", () => {
  it("matches a dependency rule and formats evidence exactly as version@name", () => {
    const input: DetectStackInput = {
      manifests: [{ path: "package.json", content: JSON.stringify({ dependencies: { next: "^16.0.2" } }) }],
      presentPaths: ["package.json"],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    expect(detectStack(input).tags).toEqual([
      { id: "next", label: "Next.js", evidence: ["package.json dependency next@16.0.2"] },
      { id: "node", label: "Node.js", evidence: ["package.json present"] },
    ]);
  });

  it("labels a devDependency match distinctly from a dependency", () => {
    const input: DetectStackInput = {
      manifests: [{ path: "package.json", content: JSON.stringify({ devDependencies: { vitest: "^4.1.2" } }) }],
      presentPaths: [],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    expect(detectStack(input).tags).toEqual([
      { id: "vitest", label: "Vitest", evidence: ["package.json devDependency vitest@4.1.2"] },
    ]);
  });

  it("matches a file rule by basename anywhere in the tree", () => {
    const input: DetectStackInput = {
      manifests: [],
      presentPaths: ["apps/api/Cargo.toml"],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    expect(detectStack(input).tags).toEqual([{ id: "rust", label: "Rust", evidence: ["apps/api/Cargo.toml present"] }]);
  });

  it("matches a file rule needing an exact nested path (.github/workflows)", () => {
    const input: DetectStackInput = {
      manifests: [],
      presentPaths: [".github", ".github/workflows", ".github/workflows/ci.yml"],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    expect(detectStack(input).tags).toEqual([
      { id: "github-actions", label: "GitHub Actions", evidence: [".github/workflows present"] },
    ]);
  });

  it("matches a manifest rule when the manifest mentions the given key", () => {
    const input: DetectStackInput = {
      manifests: [{ path: "Gemfile", content: "gem 'rails', '~> 7.1'\ngem 'pg'\n" }],
      presentPaths: ["Gemfile"],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    const tags = detectStack(input).tags;
    expect(tags.map((tag) => tag.id)).toEqual(["rails", "ruby"]);
    expect(tags.find((tag) => tag.id === "rails")?.evidence).toEqual(['Gemfile mentions "rails"']);
  });

  it("matches a manifest rule by basename when the manifest is nested (a monorepo app)", () => {
    const input: DetectStackInput = {
      manifests: [{ path: "apps/mobile/app.json", content: JSON.stringify({ expo: { name: "x" } }) }],
      presentPaths: ["apps/mobile/app.json"],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    expect(detectStack(input).tags).toEqual([
      { id: "expo", label: "Expo", evidence: ['apps/mobile/app.json mentions "expo"'] },
    ]);
  });

  it("does not match a manifest rule when the key is absent", () => {
    const input: DetectStackInput = {
      manifests: [{ path: "requirements.txt", content: "fastapi\nuvicorn\n" }],
      presentPaths: ["requirements.txt"],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    const tags = detectStack(input).tags;
    expect(tags.map((tag) => tag.id)).toEqual(["fastapi", "python"]);
    expect(tags.some((tag) => tag.id === "django")).toBe(false);
  });

  it("matches a script rule when a package.json script contains the needle", () => {
    const input: DetectStackInput = {
      manifests: [
        { path: "package.json", content: JSON.stringify({ scripts: { "docker:build": "docker build -t app ." } }) },
      ],
      presentPaths: ["package.json"],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    expect(detectStack(input).tags).toEqual([
      { id: "docker", label: "Docker", evidence: ['package.json script "docker:build" runs docker'] },
      { id: "node", label: "Node.js", evidence: ["package.json present"] },
    ]);
  });
});

describe("detectStack — ordering and aggregation", () => {
  it("orders tags by evidence count desc, then id asc", () => {
    const input: DetectStackInput = {
      manifests: [
        {
          path: "package.json",
          content: JSON.stringify({
            dependencies: { react: "19.0.0", vue: "3.0.0" },
            devDependencies: { typescript: "5.0.0" },
          }),
        },
      ],
      presentPaths: ["package.json", "tsconfig.json"],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    expect(detectStack(input).tags.map((tag) => tag.id)).toEqual(["typescript", "node", "react", "vue"]);
  });

  it("aggregates extension counts into the top 5 languages, ordered by count desc then id asc", () => {
    const input: DetectStackInput = {
      manifests: [],
      presentPaths: [],
      extensionCounts: { ts: 10, tsx: 5, py: 8, rs: 8, go: 3, rb: 3, css: 1, xyz: 100 },
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    expect(detectStack(input).languages).toEqual([
      { id: "TypeScript", files: 15 },
      { id: "Python", files: 8 },
      { id: "Rust", files: 8 },
      { id: "Go", files: 3 },
      { id: "Ruby", files: 3 },
    ]);
  });

  it("derives harnesses from marker files, in a fixed order", () => {
    const input: DetectStackInput = {
      manifests: [],
      presentPaths: [],
      extensionCounts: {},
      harnessFiles: [".cursor", "AGENTS.md", "CLAUDE.md"],
      computedAt: NOW,
      treeHash: HASH,
    };
    expect(detectStack(input).harnesses).toEqual(["claude-code", "codex", "cursor"]);
  });

  it("carries computedAt and treeHash through unchanged", () => {
    const input: DetectStackInput = {
      manifests: [],
      presentPaths: [],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    const profile = detectStack(input);
    expect(profile.computedAt).toBe(NOW);
    expect(profile.treeHash).toBe(HASH);
  });

  it("returns an empty profile for empty input", () => {
    const input: DetectStackInput = {
      manifests: [],
      presentPaths: [],
      extensionCounts: {},
      harnessFiles: [],
      computedAt: NOW,
      treeHash: HASH,
    };
    expect(detectStack(input)).toEqual({ tags: [], languages: [], harnesses: [], computedAt: NOW, treeHash: HASH });
  });
});

describe("detectStack — fixtures", () => {
  it("detects the example-web fixture (Next.js + Convex + Clerk + Tailwind)", () => {
    const profile = detectStack(loadFixture("example-web"));
    expect(profile.tags.map((tag) => tag.id)).toEqual([
      "convex",
      "next",
      "typescript",
      "clerk",
      "github-actions",
      "i18n",
      "node",
      "react",
      "tailwind",
      "vitest",
    ]);
    expect(profile.harnesses).toEqual(["claude-code"]);
    expect(profile.languages).toEqual([
      { id: "TypeScript", files: 5 },
      { id: "JSON", files: 2 },
      { id: "Markdown", files: 2 },
      { id: "CSS", files: 1 },
      { id: "YAML", files: 1 },
    ]);
  });

  it("detects the example-mobile fixture (Expo + Convex monorepo, apps/mobile)", () => {
    const profile = detectStack(loadFixture("example-mobile"));
    expect(profile.tags.map((tag) => tag.id)).toEqual([
      "convex",
      "expo",
      "i18n",
      "typescript",
      "bun",
      "clerk",
      "jest",
      "node",
      "react",
      "react-native",
      "vitest",
    ]);
    expect(profile.harnesses).toEqual(["codex"]);
    expect(profile.languages).toEqual([
      { id: "JSON", files: 3 },
      { id: "TypeScript", files: 3 },
      { id: "JavaScript", files: 1 },
      { id: "Markdown", files: 1 },
    ]);
  });

  it("detects the example-python fixture (FastAPI)", () => {
    const profile = detectStack(loadFixture("example-python"));
    expect(profile.tags.map((tag) => tag.id)).toEqual(["docker", "fastapi", "github-actions", "python"]);
    expect(profile.harnesses).toEqual([]);
  });

  it("detects nothing for the empty fixture", () => {
    const profile = detectStack(loadFixture("empty"));
    expect(profile.tags).toEqual([]);
    expect(profile.languages).toEqual([]);
    expect(profile.harnesses).toEqual([]);
  });
});
