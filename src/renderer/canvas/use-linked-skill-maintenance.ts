import { activeWorkshop } from "../../domain/source-roles";
import { useEffect, useMemo, useState } from "react";

import type { ResourceDetails, ResourceSnapshot } from "../../domain/resource-catalogue";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";
import type { DesktopApi } from "../../shared/ipc";
import type { SkillPropagationIntent } from "../../shared/skill-propagation-ipc";
import { sourcePackagePath } from "./use-owned-skill-choices";

function sourceForSkill(details: ResourceDetails, snapshot: ResourceSnapshot): SourceSkillRef | undefined {
  const ref = details.resource.ref;
  if (ref.kind !== "artifact" || ref.entry.kind !== "source" || details.resource.artifactKind !== "skill")
    return undefined;
  const owned =
    activeWorkshop(snapshot.registry)?.ref.id === ref.entry.id &&
    activeWorkshop(snapshot.registry)?.availability === "available";
  if (!owned) return undefined;
  const evidence = snapshot.roots.find(
    (root) => root.entry.kind === "source" && root.entry.id === ref.entry.id,
  )?.evidence;
  if (evidence?.status !== "observed") return undefined;
  const artifact = evidence.observation.inventory.artifacts.find((artifact) => artifact.id === ref.artifactId);
  const pkg = evidence.observation.inventory.packages?.find((pkg) => pkg.id === artifact?.packageId);
  const artifactPath = artifact && pkg ? sourcePackagePath(pkg.relativeRoot, artifact.relativePath) : undefined;
  return pkg && artifactPath ? { sourceId: ref.entry.id, packageId: pkg.id, artifactPath } : undefined;
}

export function useLinkedSkillMaintenance(
  details: ResourceDetails,
  snapshot: ResourceSnapshot,
  api: Pick<DesktopApi, "previewSkillOperation"> | null,
): Readonly<{ intent?: SkillPropagationIntent; count: number }> {
  const source = useMemo(() => sourceForSkill(details, snapshot), [details, snapshot]);
  const [available, setAvailable] = useState<Readonly<{
    source: SourceSkillRef;
    snapshot: ResourceSnapshot;
    count: number;
  }> | null>(null);
  useEffect(() => {
    let active = true;
    if (!source || !api?.previewSkillOperation) return;
    void api
      .previewSkillOperation({ intent: { kind: "maintain-current", source } })
      .then((preview) => {
        if (!active) return;
        const count =
          preview.status === "ready"
            ? (preview.propagation?.targets.filter((target) => target.state === "eligible").length ?? 0)
            : 0;
        setAvailable({ source, snapshot, count });
      })
      .catch(() => {
        if (active) setAvailable(null);
      });
    return () => {
      active = false;
    };
  }, [api, source, snapshot]);
  const count = available?.source === source && available?.snapshot === snapshot ? available.count : 0;
  return count && source ? { intent: { kind: "maintain-current", source }, count } : { count: 0 };
}
