import { LinkStorefrontWorkbench } from "./LinkStorefrontWorkbench";
import { LoadingSkeleton } from "../../components/ui/Skeleton";
import { RegisterProjectWorkbench } from "./RegisterProjectWorkbench";
import { activeWorkshop } from "../../../domain/source-roles";
import type { ReactElement } from "react";
import type { RegistryView as Registry } from "../../../domain/project-source-registry";
import type { ObservedArtifact } from "../../../domain/inventory";
import { EmptyState } from "../../components/ui/EmptyState";
import { useI18n } from "../../i18n";
import { ImportWorkbench } from "./ImportWorkbench";
import { CompatibilityWorkbench } from "./CompatibilityWorkbench";
import { CatalogueAssignmentWorkbench } from "./CatalogueAssignmentWorkbench";
import { WorkflowWorkbench } from "./WorkflowWorkbench";
import { RestoreWorkbench } from "./RestoreWorkbench";
import { AssignmentWorkbench } from "./AssignmentWorkbench";
import { ApplyWorkbench } from "./ApplyWorkbench";
import { ReceiptWorkbench } from "./ReceiptWorkbench";
import { RemoveWorkbench } from "./RemoveWorkbench";
import { packageArtifacts } from "../../library/library-data";
import type { AppShellProps } from "../../shell/routes";
import { observationKey } from "../../app-helpers";
import { findImportArtifact, findImportObservation } from "./import-route-evidence";
const NO_GRANT = async (): Promise<string | null> => null;
export type RouteChangesWorkbenchProps = Readonly<{
  route: import("../../navigation").OperationRoute;
  registry: Registry;
  shell: AppShellProps;
  onClose: () => void;
}>;
export function RouteChangesWorkbench({
  route,
  registry,
  shell: props,
  onClose,
}: RouteChangesWorkbenchProps): ReactElement {
  const { t } = useI18n();
  const unavailable = (description: string, title: string): ReactElement => (
    <WorkflowWorkbench title={title} busy={false} onClose={onClose}>
      <EmptyState description={description} title={title} />
    </WorkflowWorkbench>
  );
  if (route.screen === "operation-link-storefront")
    return (
      <LinkStorefrontWorkbench
        api={props.api}
        requestId={route.requestId}
        onClose={onClose}
        onNavigate={props.onNavigateToRoute}
        onMarketplaceChanged={props.onMarketplaceChanged}
      />
    );
  if (route.screen === "operation-register-project")
    return (
      <RegisterProjectWorkbench
        api={props.api}
        requestId={route.requestId}
        onClose={onClose}
        onNavigate={props.onNavigateToRoute}
        onProjectChanged={props.onProjectChanged}
      />
    );
  const catalogue = props.catalogue;
  if (route.screen === "operation-restore")
    return (
      <RestoreWorkbench
        api={props.api}
        onMarketplaceChanged={props.onMarketplaceChanged ?? (() => undefined)}
        onProjectChanged={props.onProjectChanged}
        onNavigateToRoute={props.onNavigateToRoute}
        operationId={route.operationId}
      />
    );
  if (route.screen === "operation-receipt")
    return (
      <ReceiptWorkbench
        api={props.api}
        onNavigateToRoute={props.onNavigateToRoute}
        operationId={route.operationId}
        returnTo={route.returnTo}
      />
    );
  if (route.screen === "operation-restore-apply")
    return (
      <RestoreWorkbench
        api={props.api}
        onMarketplaceChanged={props.onMarketplaceChanged}
        onNavigateToRoute={props.onNavigateToRoute}
        onProjectChanged={props.onProjectChanged}
        operationId={route.operationId}
      />
    );
  if (route.screen === "operation-apply") {
    const project = registry.projects.find((entry) => entry.ref.id === route.projectId);
    const source = activeWorkshop(registry);
    return project ? (
      <ApplyWorkbench
        api={props.api}
        onEnsureGrant={props.onEnsureGrant ?? NO_GRANT}
        onNavigateToRoute={props.onNavigateToRoute}
        onProjectChanged={props.onProjectChanged ?? (() => undefined)}
        project={project}
        sourceId={source?.ref.id ?? ""}
        bindingIds={route.bindingIds}
      />
    ) : (
      unavailable(t("project.unavailableDescription"), t("project.unavailableTitle"))
    );
  }
  if (route.screen === "operation-remove") {
    const project = registry.projects.find((entry) => entry.ref.id === route.projectId);
    const binding = props.bindings?.find((candidate) => candidate.bindingId === route.bindingId);
    return project ? (
      <RemoveWorkbench
        api={props.api}
        bindingId={route.bindingId}
        onEnsureGrant={async (ref) => props.onEnsureGrant?.(ref) ?? null}
        onNavigateToRoute={props.onNavigateToRoute}
        onProjectChanged={props.onProjectChanged ?? (() => undefined)}
        projectId={route.projectId}
        projectName={project.displayName || project.displayRoot}
        unitName={binding?.artifactPath.split("/").at(-1) ?? route.bindingId}
      />
    ) : (
      unavailable(t("project.unavailableDescription"), t("project.unavailableTitle"))
    );
  }
  if (route.screen === "operation-import") {
    const origin =
      route.source.kind === "project"
        ? registry.projects.find((entry) => entry.ref.id === route.source.id)
        : registry.sources.find((entry) => entry.ref.id === route.source.id);
    const observation = findImportObservation({
      entry: route.source,
      current: props.destinationObservation,
      cached: props.observations?.[observationKey(route.source)],
      root: props.resourceSnapshot?.roots.find(
        (root) => root.entry.kind === route.source.kind && root.entry.id === route.source.id,
      )?.evidence,
      audits: props.destinationAudit.report?.observations,
    });
    const artifact = findImportArtifact(observation, route.relativePath);
    const originPackageName = artifact?.packageId
      ? observation?.inventory.packages?.find((packageInfo) => packageInfo.id === artifact.packageId)?.displayName
      : undefined;
    const grantHandle =
      props.openedEntry?.status === "granted" &&
      props.openedEntry.entry.ref.kind === route.source.kind &&
      props.openedEntry.entry.ref.id === route.source.id
        ? props.openedEntry.grantHandle
        : undefined;
    return (
      <ImportWorkbench
        api={props.api}
        artifact={artifact}
        sourcePath={route.relativePath}
        onMarketplaceChanged={props.onMarketplaceChanged ?? (() => undefined)}
        onNavigateToRoute={props.onNavigateToRoute}
        origin={route.source}
        originName={origin?.displayName || origin?.displayRoot || route.source.id}
        originPackageName={originPackageName}
        returnTo={route.returnTo}
        sourceGrantHandle={grantHandle}
        targetObservation={props.marketplaceObservation ?? null}
        targetSourceId={activeWorkshop(registry)?.ref.id}
        requestId={route.requestId}
      />
    );
  }
  if (route.screen === "operation-import-catalogue") {
    // "Add to my marketplace..." from the Catalogue tab: the entry page already prepared an
    // ephemeral grant over the fetched SKILL.md (`omni:catalogue:prepare-import`) and hands this
    // route everything it resolved, so this reuses the same import operation and workbench as any
    // other artifact — no artifact ever came from a registry observation here.
    const artifact: ObservedArtifact = {
      id: `catalogue:${route.ownerRepo}/${route.skill}`,
      physicalIdentity: `catalogue:${route.ownerRepo}/${route.skill}`,
      projectionPaths: [],
      kind: "skill",
      relativePath: route.relativePath,
      displayPath: route.relativePath,
      providerIds: [],
      scope: "source",
      confidence: "exact",
      symlinkState: "none",
      ...(route.description ? { summary: route.description } : {}),
    };
    return (
      <ImportWorkbench
        api={props.api}
        artifact={artifact}
        onMarketplaceChanged={props.onMarketplaceChanged ?? (() => undefined)}
        onNavigateToRoute={props.onNavigateToRoute}
        origin={{ kind: "source", id: route.sourceId }}
        originName={`${route.name} (${t("library.catalogue.source")})`}
        returnTo={route.returnTo}
        sourceGrantHandle={route.grantHandle}
        targetObservation={props.marketplaceObservation ?? null}
        targetSourceId={activeWorkshop(registry)?.ref.id}
      />
    );
  }
  if (route.screen === "operation-compatible") {
    const source = registry.sources.find((entry) => entry.ref.id === route.sourceId);
    if (!source) return unavailable(t("library.sourceUnavailableDescription"), t("library.sourceUnavailable"));
    return (
      <CompatibilityWorkbench
        api={props.api}
        harness={route.harness}
        observation={
          props.destinationObservation?.status === "observed" ? props.destinationObservation.observation : null
        }
        onMarketplaceChanged={props.onMarketplaceChanged ?? (() => undefined)}
        onNavigateToRoute={props.onNavigateToRoute}
        packageId={route.packageId}
        returnTo={route.returnTo}
        source={source}
        requestId={route.requestId}
        sourceGrantHandle={
          props.openedEntry?.status === "granted" &&
          props.openedEntry.entry.ref.kind === "source" &&
          props.openedEntry.entry.ref.id === route.sourceId
            ? props.openedEntry.grantHandle
            : undefined
        }
      />
    );
  }
  if (route.screen === "add-to-project") {
    const project = registry.projects.find((candidate) => candidate.ref.id === route.projectId);
    return project ? (
      <CatalogueAssignmentWorkbench
        api={props.api}
        auditReport={props.destinationAudit.report}
        entry={{ ownerRepo: route.ownerRepo, skill: route.skill }}
        marketplaceObservation={props.marketplaceObservation ?? null}
        onEnsureGrant={props.onEnsureGrant ?? NO_GRANT}
        onMarketplaceChanged={props.onMarketplaceChanged}
        onNavigateToRoute={props.onNavigateToRoute}
        observations={Object.fromEntries(
          Object.entries(props.observations ?? {}).map(([key, value]) => [
            key,
            value.status === "observed" ? value.observation : undefined,
          ]),
        )}
        projectId={route.projectId}
        projectName={project.displayName || project.displayRoot}
        returnTo={route.returnTo}
      />
    ) : (
      unavailable(t("project.unavailableDescription"), t("project.unavailableTitle"))
    );
  }
  if (route.screen === "assignment") {
    const source = registry.sources.find((entry) => entry.ref.id === route.sourceId);
    const observation =
      props.destinationObservation?.status === "observed" ? props.destinationObservation.observation : null;
    const artifactPath = route.artifactPath;
    const artifact = artifactPath
      ? observation?.inventory.artifacts.find((candidate) => candidate.relativePath === artifactPath)
      : undefined;
    const packageInfo = observation?.inventory.packages?.find((candidate) => candidate.id === route.packageId);
    const unit = artifactPath
      ? catalogue?.find(
          (candidate) =>
            candidate.inPersonalSource &&
            candidate.occurrences.some(
              (occurrence) =>
                occurrence.root.kind === "source" &&
                occurrence.root.id === route.sourceId &&
                occurrence.relativePath === artifactPath,
            ),
        )
      : undefined;
    if (!source || (artifactPath && !unit))
      return unavailable(t("library.packageUnavailableDescription"), t("library.packageUnavailable"));
    return (
      <AssignmentWorkbench
        api={props.api}
        existingBindings={props.bindings}
        artifactPath={artifactPath}
        auditReport={props.destinationAudit.report}
        observations={Object.fromEntries(
          Object.entries(props.observations ?? {}).map(([key, value]) => [
            key,
            value.status === "observed" ? value.observation : undefined,
          ]),
        )}
        onBindingsChanged={props.onBindingsChanged}
        onEnsureGrant={props.onEnsureGrant ?? (async () => null)}
        onNavigate={props.onNavigateToRoute}
        packageArtifacts={!artifactPath && observation ? packageArtifacts(observation, route.packageId) : undefined}
        packageId={route.packageId}
        packageName={packageInfo?.displayName ?? route.packageId}
        preselectProjectId={route.preselectProjectId}
        projects={registry.projects.filter((project) => project.archivedAt === undefined)}
        returnTo={route.returnTo}
        source={source}
        summary={artifact?.summary}
        unit={unit}
        requestId={route.requestId}
      />
    );
  }
  return <LoadingSkeleton label={t("bootstrap.loading")} />;
}
