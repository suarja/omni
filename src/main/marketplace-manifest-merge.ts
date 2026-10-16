// Merging Omni's deterministic projections into harness manifests that the user may maintain
// by hand: identity fields only for existing entries, unknown fields and formatting preserved.
import { join } from "node:path";

import type { CompatibilityRemotePackage } from "../domain/compatibility-report";
import type { Harness } from "../domain/harness-projection";
import { createUnifiedDiff } from "../domain/unified-diff";
import { json, manifestAction, parseObject, styleOf, type ManifestAction } from "./marketplace-manifests";
import { readOptionalText } from "./fs-optional";

function sourcePath(value: unknown): string | undefined {
  if (typeof value === "string") return value.replace(/^\.\//, "");
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const path = (value as Record<string, unknown>).path;
  return typeof path === "string" ? path.replace(/^\.\//, "") : undefined;
}

function deterministicEqual(current: Record<string, unknown>, projected: Record<string, unknown>): boolean {
  return Object.entries(projected).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value));
}

export async function manifestUpdate(
  root: string,
  relativePath: string,
  projected: Record<string, unknown>,
  keep: ReadonlySet<string>,
): Promise<ManifestAction | undefined> {
  let before: string | undefined;
  try {
    before = await readOptionalText(join(root, relativePath));
  } catch {
    throw new Error(`manifest-invalid:${relativePath}`);
  }
  if (!before) return manifestAction(root, relativePath, json(projected));
  let current: Record<string, unknown>;
  try {
    current = parseObject(before);
  } catch {
    throw new Error(`manifest-invalid:${relativePath}`);
  }
  if (deterministicEqual(current, projected)) return undefined;
  const next = json({ ...current, ...projected }, styleOf(before));
  return {
    ...manifestAction(root, relativePath, next, before),
    apply: keep.has(relativePath),
    diff: createUnifiedDiff(`${relativePath} (current)`, `${relativePath} (projected)`, before, next).text,
  };
}

export async function rootManifestUpdate(
  root: string,
  relativePath: string,
  name: string,
  entries: readonly Record<string, unknown>[],
  keep: ReadonlySet<string>,
  displayName?: string,
): Promise<ManifestAction | undefined> {
  let before: string | undefined;
  try {
    before = await readOptionalText(join(root, relativePath));
  } catch {
    throw new Error(`manifest-invalid:${relativePath}`);
  }
  if (!before) {
    return manifestAction(
      root,
      relativePath,
      json({
        name,
        ...(displayName ? { interface: { displayName } } : {}),
        plugins: entries,
      }),
    );
  }
  let current: Record<string, unknown>;
  try {
    current = parseObject(before);
  } catch {
    throw new Error(`manifest-invalid:${relativePath}`);
  }
  if (!Array.isArray(current.plugins)) throw new Error(`manifest-invalid:${relativePath}`);
  const existing = current.plugins as unknown[];
  const nextEntries = [...existing];
  const applyEntries = [...existing];
  let changed = false;
  let hasUnkeptUpdate = false;
  for (const entry of entries) {
    const entryPath = sourcePath(entry.source);
    const index = existing.findIndex(
      (item) =>
        sourcePath((item as Record<string, unknown>)?.source) === entryPath ||
        (item as Record<string, unknown>)?.name === entry.name,
    );
    if (index < 0) {
      nextEntries.push(entry);
      applyEntries.push(entry);
      changed = true;
      continue;
    }
    // An entry the user already maintains is kept as it is: only its identity (name, source) is
    // deterministic; `category`, `policy`, or fields the harness format may not accept are never
    // added to it. A different source is drift, shown as an update the user can keep or refuse.
    const currentEntry = existing[index] as Record<string, unknown>;
    const identity = { name: entry.name, source: entry.source };
    if (deterministicEqual(currentEntry, identity)) continue;
    nextEntries[index] = { ...currentEntry, ...identity };
    changed = true;
    if (keep.has(relativePath)) applyEntries[index] = { ...currentEntry, ...identity };
    else hasUnkeptUpdate = true;
  }
  if (!changed) return undefined;
  const next = json({ ...current, plugins: nextEntries }, styleOf(before));
  const applyContent = hasUnkeptUpdate ? json({ ...current, plugins: applyEntries }, styleOf(before)) : undefined;
  return {
    ...manifestAction(root, relativePath, next, before),
    apply: !hasUnkeptUpdate || nextEntries.length > existing.length,
    ...(applyContent ? { applyContent } : {}),
    diff: createUnifiedDiff(`${relativePath} (current)`, `${relativePath} (projected)`, before, next).text,
  };
}

export function remoteEntry(remote: CompatibilityRemotePackage, harness: Harness): Record<string, unknown> | undefined {
  const source = remote.source;
  const locator = remote.locator ?? "";
  const parsed =
    source?.source === "github" && source.repo
      ? { source: { source: "github", repo: source.repo }, ...(source.ref ? { ref: source.ref } : {}) }
      : source?.source === "url" && source.url
        ? { source: { source: "url", url: source.url }, ...(source.ref ? { ref: source.ref } : {}) }
        : locator.startsWith("github:")
          ? (() => {
              const [repo, ref] = locator.slice(7).split("@", 2);
              return repo ? { source: { source: "github", repo }, ...(ref ? { ref } : {}) } : undefined;
            })()
          : locator.startsWith("url:")
            ? { source: { source: "url", url: locator.slice(4) } }
            : undefined;
  if (!parsed) return undefined;
  const metadata = {
    name: remote.name,
    ...(remote.version ? { version: remote.version } : {}),
    ...(remote.description ? { description: remote.description } : {}),
  };
  if (harness === "codex") {
    const source =
      parsed.source.source === "github"
        ? {
            source: "url",
            url: `https://github.com/${parsed.source.repo}.git`,
            ...(parsed.ref ? { ref: parsed.ref } : {}),
          }
        : { ...parsed.source, ...(parsed.ref ? { ref: parsed.ref } : {}) };
    return {
      ...metadata,
      source,
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    };
  }
  if (harness === "claude-code" && parsed.source.source === "url") {
    const match = String(parsed.source.url).match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/u);
    if (!match) return undefined;
    return { ...metadata, source: { source: "github", repo: match[1], ...(parsed.ref ? { ref: parsed.ref } : {}) } };
  }
  return { ...metadata, source: parsed.source, ...(parsed.ref ? { ref: parsed.ref } : {}) };
}
