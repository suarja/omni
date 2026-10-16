import { createHash } from "node:crypto";
import { createLocalInventoryPort } from "../../adapters/inventory/local-filesystem";
import { parseSkillsLock } from "../../domain/skill-origins/skills-lock";
import type { SkillLockEntry } from "../../domain/skill-origins/types";
import type { RegistryState } from "../../domain/project-source-registry";
import { parseExternalRepository } from "../../domain/external-library";
import type { ExternalMacSources } from "../../shared/external-library-ipc";
import { agentHomeDir } from "../agent-harnesses";
import { classifyGitFailure } from "../git-command";
import { optionalText } from "../storefronts/files";

export type ExternalLockedUse = Readonly<{
  id: string;
  projectId: string;
  projectName: string;
  root: string;
  entry: SkillLockEntry;
}>;
export async function detectExternalUses(registry: RegistryState): Promise<{
  uses: ExternalLockedUse[];
  diagnostics: ExternalMacSources["error"][];
}> {
  const uses: ExternalLockedUse[] = [];
  const diagnostics: ExternalMacSources["error"][] = [];
  for (const project of registry.projects.filter((project) => !project.archivedAt)) {
    try {
      const text = await optionalText(createLocalInventoryPort(project.locator.canonicalPath), "skills-lock.json");
      if (text === undefined) continue;
      const parsed = parseSkillsLock(JSON.parse(text));
      for (const issue of parsed.issues)
        diagnostics.push({ type: "other", message: `${project.id}: ${issue.message}` });
      for (const entry of parsed.entries)
        uses.push({
          id: createHash("sha256")
            .update(JSON.stringify([project.id, entry.source.locator, entry.skillKey]))
            .digest("hex"),
          projectId: project.id,
          projectName: project.displayName,
          root: project.locator.canonicalPath,
          entry,
        });
    } catch (error) {
      diagnostics.push({
        ...classifyGitFailure(error),
        message: `Project ${project.id} lock could not be read safely. Restore access and check again.`,
      });
    }
  }
  return { uses, diagnostics };
}
export async function readExternalSourcesOnMac(
  options: Readonly<{ homeDir?: string; isPackaged?: boolean }>,
): Promise<ExternalMacSources> {
  try {
    // The selected agent home seam confines this read to one file, including fake HOME reception.
    const root = agentHomeDir(options);
    const text = await optionalText(createLocalInventoryPort(root), ".claude/plugins/known_marketplaces.json");
    if (!text) return { status: "ready", marketplaces: [] };
    const records: unknown = JSON.parse(text);
    if (!records || typeof records !== "object" || Array.isArray(records))
      throw new Error("Claude Code marketplace list is invalid.");
    const marketplaces: ExternalMacSources["marketplaces"] = [];
    if (Object.keys(records).length > 10000) throw new Error("Claude Code marketplace list exceeds the entry limit.");
    for (const [id, value] of Object.entries(records)) {
      if (!value || typeof value !== "object" || !("source" in value)) continue;
      const source = value.source;
      if (
        !source ||
        typeof source !== "object" ||
        !("repo" in source) ||
        !("source" in source) ||
        source.source !== "github" ||
        typeof source.repo !== "string"
      )
        continue;
      try {
        marketplaces.push({ id, repo: parseExternalRepository(source.repo) });
      } catch {
        /* Other Claude sources are outside this library. */
      }
    }
    return { status: "ready", marketplaces };
  } catch (error) {
    return { status: "unavailable", marketplaces: [], error: classifyGitFailure(error) };
  }
}
