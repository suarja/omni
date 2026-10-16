import type { PackageManifest } from "../../domain/marketplace-format";
import { parsePackageManifest } from "../../domain/marketplace-format";
import { projectPluginManifest } from "../../domain/harness-projection";
import { createUnifiedDiff } from "../../domain/unified-diff";
import { hashContent, json, parseObject } from "../marketplace-manifests";
import type { FileTree } from "./publish-context";
import type { OperationAction } from "../../shared/operations-ipc";
export type PublicationEdit = Readonly<{ view: OperationAction; before?: Uint8Array; after?: Uint8Array }>;
export function bytes(text: string): Uint8Array {
  return Buffer.from(text);
}
export function effectiveTree(raw: FileTree, manifest: PackageManifest): FileTree {
  const tree: Record<string, Uint8Array> = Object.assign(Object.create(null), raw);
  delete tree["omni.plugin.json"];
  delete tree["ORIGIN.md"];
  for (const harness of ["claude-code", "codex"] as const) {
    const path = `${harness === "claude-code" ? ".claude-plugin" : ".codex-plugin"}/plugin.json`;
    const existing = raw[path] ? parseObject(Buffer.from(raw[path]).toString("utf8")) : {};
    tree[path] = bytes(json({ ...existing, ...projectPluginManifest(manifest, harness) }));
  }
  return tree;
}
export function manifestFrom(bytes: Uint8Array | undefined): PackageManifest {
  if (!bytes) throw new Error("The workshop plugin needs omni.plugin.json before publication.");
  return parsePackageManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
}
export function originText(
  repository: string,
  packagePath: string,
  commit: string,
  date: string,
  existing?: Uint8Array,
): string {
  const text = existing ? Buffer.from(existing).toString("utf8") : "";
  const section = /^## Storefront-only edits\s*$/mu.exec(text);
  return (
    `# Origin\n\nThis plugin is a published copy from the author's private workshop marketplace.\n\n- Source repository: ${repository} (private)\n- Source path: ${packagePath}\n- Source commit: ${commit}\n- Published: ${date.slice(0, 10)}\n` +
    (section ? `\n${text.slice(section.index)}` : "")
  );
}
export function updatePluginList(readme: string, pluginId: string, description?: string): string {
  const open = "<!-- omni:plugins -->";
  const close = "<!-- /omni:plugins -->";
  if (
    (readme.match(/<!-- omni:plugins -->/gu) ?? []).length > 1 ||
    (readme.match(/<!-- \/omni:plugins -->/gu) ?? []).length > 1
  )
    throw new Error("README plugin list markers are ambiguous. Repair them before publication.");
  let start = readme.indexOf(open);
  let end = readme.indexOf(close);
  if (start < 0 !== end < 0 || (start >= 0 && end < start))
    throw new Error("README plugin list markers are incomplete. Repair them before publication.");
  if (start < 0) {
    const heading = /^## Plugins[^\r\n]*(?:\r?\n|$)/mu.exec(readme);
    if (!heading) throw new Error("README needs a Plugins heading before publication.");
    const index = heading.index + heading[0].length;
    readme = `${readme.slice(0, index)}${open}\n${close}\n${readme.slice(index)}`;
    start = readme.indexOf(open);
    end = readme.indexOf(close);
  }
  const lines = readme
    .slice(start + open.length, end)
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.includes(`](plugins/${pluginId})`));
  const safeDescription = description?.replace(/[\r\n]/gu, " ");
  lines.push(`- [${pluginId}](plugins/${pluginId})${safeDescription ? `: ${safeDescription}` : ""}`);
  return `${readme.slice(0, start + open.length)}\n${lines.join("\n")}\n${readme.slice(end)}`;
}
export function edit(
  path: string,
  before: Uint8Array | undefined,
  after: Uint8Array | undefined,
): PublicationEdit | undefined {
  if ((before === undefined && after === undefined) || (before && after && hashContent(before) === hashContent(after)))
    return undefined;
  const diff = createUnifiedDiff(`${path} (current)`, `${path} (proposed)`, before ?? "", after ?? "").text;
  return {
    before,
    after,
    view: {
      kind: after === undefined ? "delete-file" : "write-file",
      relativePath: path,
      ...(before ? { beforeHash: hashContent(before) } : {}),
      ...(after ? { afterHash: hashContent(after), byteLength: after.byteLength } : {}),
      diff,
    },
  };
}
export function diffStats(
  before: Uint8Array | undefined,
  after: Uint8Array | undefined,
): { added: number; removed: number } {
  const text = createUnifiedDiff("before", "after", before ?? "", after ?? "").text;
  return {
    added: text.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    removed: text.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
  };
}

export function retainCommitEdit(
  path: string,
  current: Uint8Array | undefined,
  committed: Uint8Array | undefined,
): PublicationEdit | undefined {
  const change = edit(path, committed, current);
  if (!change) return undefined;
  return { before: current, after: current, view: { ...change.view, beforeHash: current && hashContent(current) } };
}
