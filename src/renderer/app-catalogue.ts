import { useMemo } from "react";

import { buildCatalogue, type CatalogueUnit } from "./catalogue/catalogue";
import type { AuditObservation, AuditReport } from "./audit/audit-report";
import type { RegistryViewResponse } from "../shared/registry-ipc";

// Split out of App.tsx (kept it under the project's file-size target): the project catalogue is
// only worth building once at least one observed entry carries an identity — otherwise every
// project page would fall back to its un-catalogued render for no reason.
export function useAppCatalogue(
  currentAuditReport: AuditReport | null,
  entryIdentities: Readonly<Record<string, AuditObservation>>,
  registry: RegistryViewResponse | null,
): readonly CatalogueUnit[] | undefined {
  return useMemo(() => {
    const report = currentAuditReport ?? { observations: [], findings: [], unavailable: [] };
    const hasIdentities = [...report.observations, ...Object.values(entryIdentities)].some(
      (observation) => (observation.identities?.length ?? 0) > 0,
    );
    return hasIdentities && registry?.status === "ready"
      ? buildCatalogue({ registry: registry.registry, report, entryIdentities })
      : undefined;
  }, [currentAuditReport, entryIdentities, registry]);
}
