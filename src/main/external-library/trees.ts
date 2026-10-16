import { createHash } from "node:crypto";
import { basename } from "node:path";
import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { hashSkillFolder } from "../../adapters/inventory/skill-folder-hash";
import { parseFrontmatter } from "../../adapters/inventory/frontmatter";
import type { InventoryFilesystemPort } from "../../ports/inventory";
import type { ExternalSkill } from "../../shared/external-library-ipc";
import { readGitText } from "../git-read";
import { optionalText } from "../storefronts/files";

export type ExternalTree = Readonly<{ hash: string; files: Record<string, Uint8Array> }>;
const IGNORED = new Set([".git", "node_modules"]);
export function fingerprintExternalFiles(files: Readonly<Record<string, Uint8Array>>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort((a, b) => a.localeCompare(b))) {
    hash.update(path);
    hash.update(files[path]!);
  }
  return hash.digest("hex");
}
export async function readExternalTree(root: string, folder: string): Promise<ExternalTree | undefined> {
  const filesystem = createLocalInventoryPort(root);
  const fingerprint = await hashSkillFolder(filesystem, folder, { remainingBytes: 32 * 1024 * 1024 });
  if (fingerprint.status !== "hashed") return undefined;
  const files: Record<string, Uint8Array> = Object.create(null);
  let bytes = 0;
  const visit = async (path: string, prefix: string): Promise<void> => {
    for (const node of await filesystem.listDirectory(path)) {
      if (node.type === "directory" && IGNORED.has(node.name)) continue;
      const relative = prefix ? `${prefix}/${node.name}` : node.name;
      if (node.type === "directory") await visit(`${path}/${node.name}`, relative);
      else if (node.type === "file") {
        if (Object.keys(files).length >= 512) throw new Error("The external skill exceeds the file limit.");
        const content = await filesystem.readBytes(`${path}/${node.name}`);
        bytes += content.byteLength;
        if (bytes > 16 * 1024 * 1024) throw new Error("The external skill exceeds the byte limit.");
        files[relative] = content;
      } else throw new Error("The external skill contains an unsafe entry.");
    }
  };
  await visit(folder, "");
  return fingerprintExternalFiles(files) === fingerprint.hash ? { hash: fingerprint.hash, files } : undefined;
}
export async function readExternalLicence(filesystem: InventoryFilesystemPort): Promise<ExternalSkill["licence"]> {
  let text: string | undefined;
  for (const node of await filesystem.listDirectory("")) {
    if (node.type === "file" && /^(?:licen[sc]e|copying)(?:[._-].*)?$/iu.test(node.name)) {
      text = await optionalText(filesystem, node.name);
      if (text) break;
    }
  }
  if (!text) return "none";
  if (/MIT License|SPDX-License-Identifier:\s*MIT/iu.test(text)) return "MIT";
  if (/Apache License[\s\S]{0,100}Version 2\.0|SPDX-License-Identifier:\s*Apache-2\.0/iu.test(text))
    return "Apache-2.0";
  return "other";
}
export async function readExternalSkills(root: string, licence: ExternalSkill["licence"]): Promise<ExternalSkill[]> {
  const filesystem = createLocalInventoryPort(root, { maxEntries: 10000 });
  const skills: ExternalSkill[] = [];
  let entries = 0;
  const visit = async (folder: string): Promise<void> => {
    const nodes = await filesystem.listDirectory(folder);
    if ((entries += nodes.length) > 10000) throw new Error("External source exceeds the entry limit.");
    if (nodes.some((node) => node.name === "SKILL.md" && node.type === "file") && folder) {
      const frontmatter = parseFrontmatter(await filesystem.readText(`${folder}/SKILL.md`), true);
      if (frontmatter.valid) {
        skills.push({
          path: folder,
          name: frontmatter.name ?? basename(folder),
          description: frontmatter.description ?? "",

          licence,
          useIds: [],
        });
      }
    }
    for (const node of nodes)
      if (node.type === "directory" && !IGNORED.has(node.name))
        await visit(folder ? `${folder}/${node.name}` : node.name);
  };
  await visit("");
  const history = await readGitText(root, ["log", "--format=%x00%cI", "--name-only"]);
  const pending = new Set(skills.map((skill) => skill.path));
  let date: string | undefined;
  for (const line of (history ?? "").split(/\r?\n/u)) {
    if (line.startsWith("\0")) {
      const timestamp = line.slice(1);
      date = Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : undefined;
    } else if (line && date) {
      for (const skill of skills)
        if (pending.has(skill.path) && line.startsWith(`${skill.path}/`)) {
          skill.lastChangeAt = date;
          pending.delete(skill.path);
        }
    }
    if (!pending.size) break;
  }
  return skills.sort((a, b) => a.path.localeCompare(b.path));
}
