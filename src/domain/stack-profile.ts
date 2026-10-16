import { EXTENSION_LANGUAGES, STACK_TAGS, type StackTagDefinition, type StackTagRule } from "./stack-tags";

/**
 * Offline stack detection: pure, no IO, no
 * model. `src/main/stack-profile-ipc.ts` walks a project's granted root through the inventory
 * port, gathers this shape, and hands it to `detectStack`; nothing here touches a filesystem.
 */

export type ManifestInput = Readonly<{ path: string; content: string }>;

export type DetectStackInput = Readonly<{
  manifests: readonly ManifestInput[];
  presentPaths: readonly string[];
  extensionCounts: Readonly<Record<string, number>>;
  harnessFiles: readonly string[];
  computedAt: string;
  treeHash: string;
}>;

export type StackTag = Readonly<{ id: string; label: string; evidence: readonly string[] }>;
export type StackLanguage = Readonly<{ id: string; files: number }>;
export type StackHarness = "claude-code" | "codex" | "cursor";

export type StackProfile = Readonly<{
  tags: readonly StackTag[];
  languages: readonly StackLanguage[];
  harnesses: readonly StackHarness[];
  computedAt: string;
  treeHash: string;
}>;

type PackageManifest = Readonly<{
  dependencies: Readonly<Record<string, string>>;
  devDependencies: Readonly<Record<string, string>>;
  scripts: Readonly<Record<string, string>>;
}>;

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function basenameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") result[key] = raw;
  }
  return result;
}

function parsePackageJson(content: string): PackageManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  return {
    dependencies: stringRecord(record.dependencies),
    devDependencies: stringRecord(record.devDependencies),
    scripts: stringRecord(record.scripts),
  };
}

/** Drops a semver range prefix (`^`, `~`, `>=`, …) so evidence reads `next@16.0.2`, not `^16.0.2`. */
function stripVersionRange(version: string): string {
  const stripped = version.trim().replace(/^[\^~>=<\s]+/, "");
  return stripped || version.trim();
}

function packageManifests(manifests: readonly ManifestInput[]): readonly ManifestInput[] {
  return manifests.filter((manifest) => basenameOf(manifest.path) === "package.json");
}

function matchDependency(
  rule: Extract<StackTagRule, { kind: "dependency" }>,
  manifests: readonly ManifestInput[],
): string[] {
  const evidence: string[] = [];
  for (const manifest of packageManifests(manifests)) {
    const parsed = parsePackageJson(manifest.content);
    if (!parsed) continue;
    for (const name of rule.names) {
      if (Object.hasOwn(parsed.dependencies, name)) {
        evidence.push(`${manifest.path} dependency ${name}@${stripVersionRange(parsed.dependencies[name]!)}`);
      } else if (Object.hasOwn(parsed.devDependencies, name)) {
        evidence.push(`${manifest.path} devDependency ${name}@${stripVersionRange(parsed.devDependencies[name]!)}`);
      }
    }
  }
  return evidence;
}

function matchFile(rule: Extract<StackTagRule, { kind: "file" }>, presentPaths: readonly string[]): string[] {
  const evidence: string[] = [];
  for (const rulePath of rule.paths) {
    const bySegment = rulePath.includes("/");
    const match = presentPaths.find((candidate) =>
      bySegment ? candidate === rulePath : basenameOf(candidate) === rulePath,
    );
    if (match) evidence.push(`${match} present`);
  }
  return evidence;
}

function matchManifest(
  rule: Extract<StackTagRule, { kind: "manifest" }>,
  manifests: readonly ManifestInput[],
): string[] {
  const bySegment = rule.path.includes("/");
  const manifest = manifests.find((candidate) =>
    bySegment ? candidate.path === rule.path : basenameOf(candidate.path) === rule.path,
  );
  if (!manifest) return [];
  if (!rule.keys || rule.keys.length === 0) return [`${manifest.path} present`];
  const lowered = manifest.content.toLowerCase();
  const evidence: string[] = [];
  for (const key of rule.keys) {
    if (lowered.includes(key.toLowerCase())) evidence.push(`${manifest.path} mentions "${key}"`);
  }
  return evidence;
}

function matchScript(rule: Extract<StackTagRule, { kind: "script" }>, manifests: readonly ManifestInput[]): string[] {
  const evidence: string[] = [];
  for (const manifest of packageManifests(manifests)) {
    const parsed = parsePackageJson(manifest.content);
    if (!parsed) continue;
    for (const [scriptName, command] of Object.entries(parsed.scripts)) {
      const lowered = command.toLowerCase();
      const needle = rule.contains.find((candidate) => lowered.includes(candidate.toLowerCase()));
      if (needle) evidence.push(`${manifest.path} script "${scriptName}" runs ${needle}`);
    }
  }
  return evidence;
}

function matchRule(rule: StackTagRule, input: DetectStackInput): readonly string[] {
  if (rule.kind === "dependency") return matchDependency(rule, input.manifests);
  if (rule.kind === "file") return matchFile(rule, input.presentPaths);
  if (rule.kind === "manifest") return matchManifest(rule, input.manifests);
  return matchScript(rule, input.manifests);
}

function evidenceForTag(definition: StackTagDefinition, input: DetectStackInput): readonly string[] {
  const evidence = new Set<string>();
  for (const rule of definition.rules) {
    for (const item of matchRule(rule, input)) evidence.add(item);
  }
  return [...evidence];
}

function detectTags(input: DetectStackInput): readonly StackTag[] {
  return STACK_TAGS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    evidence: evidenceForTag(definition, input),
  }))
    .filter((tag) => tag.evidence.length > 0)
    .sort((left, right) => right.evidence.length - left.evidence.length || compare(left.id, right.id));
}

function detectLanguages(extensionCounts: Readonly<Record<string, number>>): readonly StackLanguage[] {
  const totals = new Map<string, number>();
  for (const [extension, count] of Object.entries(extensionCounts)) {
    if (count <= 0) continue;
    const language = EXTENSION_LANGUAGES[extension.toLowerCase()];
    if (!language) continue;
    totals.set(language, (totals.get(language) ?? 0) + count);
  }
  return [...totals.entries()]
    .map(([id, files]) => ({ id, files }))
    .sort((left, right) => right.files - left.files || compare(left.id, right.id))
    .slice(0, 5);
}

function detectHarnesses(harnessFiles: readonly string[]): readonly StackHarness[] {
  const markers = new Set(harnessFiles);
  const harnesses: StackHarness[] = [];
  if (markers.has("CLAUDE.md") || markers.has(".claude")) harnesses.push("claude-code");
  if (markers.has("AGENTS.md") || markers.has(".codex")) harnesses.push("codex");
  if (markers.has(".cursor")) harnesses.push("cursor");
  return harnesses;
}

export function detectStack(input: DetectStackInput): StackProfile {
  return {
    tags: detectTags(input),
    languages: detectLanguages(input.extensionCounts),
    harnesses: detectHarnesses(input.harnessFiles),
    computedAt: input.computedAt,
    treeHash: input.treeHash,
  };
}
