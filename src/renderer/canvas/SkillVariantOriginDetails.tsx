import { harnessLabel } from "./project-view-model";
import { useEffect, useState, type ReactElement } from "react";

import type { ResourceDetails, ResourceSnapshot } from "../../domain/resource-catalogue";
import type { DesktopApi } from "../../shared/ipc";
import type { SourceSkillRef } from "../../domain/skill-reconciliation/types";
import type { ReadSkillVariantOriginResponse } from "../../shared/skill-variant-effects";
import { useI18n } from "../i18n";

function sourceFor(details: ResourceDetails, snapshot: ResourceSnapshot): SourceSkillRef | undefined {
  const { resource, parent } = details;
  if (
    resource.ref.kind !== "artifact" ||
    resource.ref.entry.kind !== "source" ||
    parent?.kind !== "package" ||
    resource.artifactKind !== "skill" ||
    !resource.relativePath
  )
    return undefined;
  const root = snapshot.roots.find(
    ({ entry }) => entry.kind === "source" && entry.id === resource.ref.entry.id,
  )?.evidence;
  if (root?.status !== "observed") return undefined;
  const pkg = root.observation.inventory.packages?.find(({ id }) => id === parent.packageId);
  if (!pkg) return undefined;
  const prefix = pkg.relativeRoot === "root" ? "" : `${pkg.relativeRoot.replace(/\/$/u, "")}/`;
  if (prefix && !resource.relativePath.startsWith(prefix)) return undefined;
  const relative = prefix ? resource.relativePath.slice(prefix.length) : resource.relativePath;
  const artifactPath = relative.replace(/\/SKILL\.md$/iu, "");
  return { sourceId: resource.ref.entry.id, packageId: parent.packageId, artifactPath };
}

export function SkillVariantOriginDetails(
  props: Readonly<{
    api: Pick<DesktopApi, "readSkillVariantOrigin"> | null;
    details: ResourceDetails;
    snapshot: ResourceSnapshot;
  }>,
): ReactElement | null {
  const { t } = useI18n();
  const source = sourceFor(props.details, props.snapshot);
  const [state, setState] = useState<Readonly<{ key: string; response: ReadSkillVariantOriginResponse }> | null>(null);
  const key = source ? JSON.stringify(source) : "";
  useEffect(() => {
    let active = true;
    if (!source || !props.api?.readSkillVariantOrigin) {
      setState(null);
      return () => {
        active = false;
      };
    }
    void props.api
      .readSkillVariantOrigin(source)
      .then((response) => {
        if (active) setState({ key, response });
      })
      .catch(() => {
        if (active)
          setState({ key, response: { status: "unavailable", reason: t("skillManagement.variantOriginUnavailable") } });
      });
    return () => {
      active = false;
    };
  }, [key, props.api, source?.artifactPath, source?.packageId, source?.sourceId, t]);
  if (!source || state?.key !== key || state.response.status === "absent") return null;
  return (
    <section aria-label={t("skillManagement.variantOrigin")} className="canvas-variant-origin">
      <h3>{t("skillManagement.variantOrigin")}</h3>
      {state.response.status === "unavailable" ? (
        <p>{t("skillManagement.variantOriginUnavailable")}</p>
      ) : (
        <dl>
          <dt>{t("skillManagement.variantId")}</dt>
          <dd>
            <code>{state.response.origin.variantId}</code>
          </dd>
          <dt>{t("skillManagement.forkOf")}</dt>
          <dd>
            <code>{state.response.origin.forkOf}</code>
          </dd>
          <dt>{t("skillManagement.capturedAt")}</dt>
          <dd>{state.response.origin.capturedAt}</dd>
          <dt>{t("skillManagement.capturedFrom")}</dt>
          <dd>
            <code>
              {harnessLabel(state.response.origin.capturedFrom.location.harnessId)} ·{" "}
              {state.response.origin.capturedFrom.location.folderPath}
            </code>
          </dd>
          <dt>{t("skillManagement.capturedRevision")}</dt>
          <dd>
            <code>{state.response.origin.capturedFrom.revision.hash}</code>
          </dd>
          {state.response.origin.declaredOrigin ? (
            <>
              <dt>{t("skillManagement.declaredOrigin")}</dt>
              <dd>
                <code>{state.response.origin.declaredOrigin.locator}</code>
              </dd>
            </>
          ) : null}
          {state.response.origin.approvedSource ? (
            <>
              <dt>{t("skillManagement.approvedSource")}</dt>
              <dd>
                <code>
                  {state.response.origin.approvedSource.packageId}/{state.response.origin.approvedSource.artifactPath}
                </code>
              </dd>
            </>
          ) : null}
          {state.response.origin.license ? (
            <>
              <dt>{t("skillManagement.variantLicense")}</dt>
              <dd>{state.response.origin.license}</dd>
            </>
          ) : null}
        </dl>
      )}
    </section>
  );
}
