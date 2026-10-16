import type { ExternalUse } from "../../../shared/external-library-ipc";
import type { TranslationFunction } from "../../i18n";
import { useProjectLabel, useStateLabel } from "../external-library/presentation";

export type UseChip = Readonly<{ id: string; label: string; className: string }>;
export function skillUseChips(
  uses: readonly ExternalUse[],
  peers: readonly ExternalUse[],
  t: TranslationFunction,
): readonly UseChip[] {
  if (!uses.length) return [{ id: "absent", label: t("externalLibrary.noProject"), className: "is-absent" }];
  const projects = new Map<string, UseChip>();
  const states = new Map<string, UseChip>();
  for (const use of uses) {
    const label = useProjectLabel(use, peers);
    const id = `${use.projectId}:${label}`;
    projects.set(id, { id, label, className: "is-installed" });
    const stateLabel = useStateLabel(use, t);
    const stateId = `${use.state}:${stateLabel}`;
    states.set(stateId, {
      id: stateId,
      label: stateLabel,
      className: `is-${use.state === "up-to-date" ? "current" : use.state}`,
    });
  }
  return [...projects.values(), ...states.values()];
}
