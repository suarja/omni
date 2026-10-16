import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { SkillLocationKey } from "../../../domain/skill-reconciliation/types";
import type { SkillResult } from "../../../shared/skill-management-ipc";
import type { useI18n } from "../../i18n";
import { harnessLabel } from "../../operations/assignment-plan-view";
import { sourcePackagePath } from "../use-owned-skill-choices";

type Translate = ReturnType<typeof useI18n>["t"];

export function copyLocationKey(location: SkillLocationKey): string {
  return JSON.stringify([location.projectId, location.harnessId, location.folderPath]);
}

export function copyManagementResultContext(
  result: SkillResult,
): Readonly<{ skillId: string; location: SkillLocationKey }> | undefined {
  if (result.detachment) return { skillId: result.detachment.skillId, location: result.detachment.location };
  if (result.link) return { skillId: result.link.skillId, location: result.link.location };
  if (result.capture) return { skillId: result.capture.skillId, location: result.capture.location };
  const resolution = result.resolution;
  if (resolution?.targets.length === 1) {
    const target = resolution.targets[0];
    return target ? { skillId: resolution.skillId, location: target.location } : undefined;
  }
  return undefined;
}

function shortestFolderSuffix(location: SkillLocationKey, peers: readonly SkillLocationKey[]): string {
  const parts = location.folderPath.split("/");
  for (let length = 1; length <= parts.length; length += 1) {
    const suffix = parts.slice(-length).join("/");
    if (!peers.some((peer) => peer !== location && peer.folderPath.split("/").slice(-length).join("/") === suffix)) {
      return suffix;
    }
  }
  return location.folderPath;
}

export function copyLocationOptions(
  locations: readonly SkillLocationKey[],
  t: Translate,
): readonly Readonly<{ value: string; label: string }>[] {
  return locations.map((location) => {
    const sameHarness = locations.filter((peer) => peer.harnessId === location.harnessId);
    const label = harnessLabel(location.harnessId, t);
    return {
      value: copyLocationKey(location),
      label: sameHarness.length > 1 ? `${label} · ${shortestFolderSuffix(location, sameHarness)}` : label,
    };
  });
}

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[\u0300-\u036f]/gu, "")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 64)
      .replace(/-$/u, "") || "personal-copy"
  );
}

export function safeVariantKey(
  snapshot: ResourceSnapshot,
  sourceId: string,
  packageId: string,
  label: string,
  projectName: string,
): string {
  const root = snapshot.roots.find((entry) => entry.entry.kind === "source" && entry.entry.id === sourceId);
  if (!root || root.evidence.status !== "observed") return slug(`${label}-${projectName}`);
  const pkg = root.evidence.observation.inventory.packages?.find((entry) => entry.id === packageId);
  if (!pkg) return slug(`${label}-${projectName}`);
  const occupied = new Set(
    root.evidence.observation.inventory.artifacts
      .filter((artifact) => artifact.kind === "skill" && artifact.packageId === packageId)
      .map((artifact) => {
        const path = sourcePackagePath(pkg.relativeRoot, artifact.relativePath);
        return path?.startsWith("skills/") ? path.slice("skills/".length) : undefined;
      })
      .filter((key): key is string => Boolean(key)),
  );
  const base = slug(`${label}-${projectName}`);
  let candidate = base;
  let suffix = 2;
  while (occupied.has(candidate) && suffix <= 1000) {
    const tail = `-${suffix++}`;
    candidate = `${base.slice(0, 64 - tail.length).replace(/-$/u, "")}${tail}`;
  }
  return candidate;
}
