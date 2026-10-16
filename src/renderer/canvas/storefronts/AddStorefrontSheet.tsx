import { storefrontDestination } from "../../../domain/storefront-destination";
import type { DesktopApi } from "../../../shared/ipc";
import { useCallback, useRef, useState, type ReactElement } from "react";
import type { NewStorefront, CreateStorefrontRequest } from "../../../shared/publication-operations-ipc";
import type { StorefrontInspectResponse } from "../../../shared/storefronts-ipc";
import { parseStorefrontInspectResponse, parseStorefrontLinkResult } from "../../../shared/storefronts-ipc";
import { activeWorkshop } from "../../../domain/source-roles";
import { useI18n } from "../../i18n";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { useCanvasRail } from "../rail/rail-context";
import { useOptionalCanvasToast } from "../CanvasToast";
import type { WorkspaceSetupInputs } from "../setup/workspace-setup-types";
import { NewStorefrontFields } from "./NewStorefrontFields";
import { PublicationChecks } from "./PublicationChecks";
import { usePublication } from "./use-publication";
import "./storefronts.css";

export function AddStorefrontSheet(
  props: Readonly<{
    setup: WorkspaceSetupInputs;
    onExternal: () => void;
    onClose: () => void;
    onApplyingChange: (busy: boolean) => void;
  }>,
): ReactElement {
  const { t } = useI18n(),
    rail = useCanvasRail(),
    toast = useOptionalCanvasToast();
  const api: Partial<DesktopApi> | null = rail?.canvas.api ?? props.setup.api;
  const [mode, setMode] = useState<"link" | "create">("link");
  const [inspection, setInspection] = useState<Extract<StorefrontInspectResponse, { status: "ready" }> | null>(null);
  const [creation, setCreation] = useState<CreateStorefrontRequest | null>(null),
    [repository, setRepository] = useState("");
  const [error, setError] = useState<string | null>(null),
    [reading, setReading] = useState(false),
    [linking, setLinking] = useState(false);
  const locked = useRef(false);
  const operation = usePublication(api, mode === "create" ? creation : null, undefined, props.onApplyingChange);
  const busy = reading || linking || operation.busy;
  const workshop = activeWorkshop(props.setup.snapshot.registry)?.displayName ?? t("projectView.marketplace");
  const onChange = useCallback((value: NewStorefront | null, repository: string): void => {
    setCreation(value ? { kind: "create-storefront", ...value } : null);
    setRepository(repository);
  }, []);
  async function inspect(): Promise<void> {
    if (locked.current || !api?.inspectStorefront) return;
    locked.current = true;
    setReading(true);
    setError(null);
    setInspection(null);
    props.onApplyingChange(true);
    try {
      const result = parseStorefrontInspectResponse(await api.inspectStorefront());
      if (result.status === "ready") setInspection(result);
      else if (result.status === "blocked") setError(result.message);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("storefronts.unavailable"));
    } finally {
      locked.current = false;
      setReading(false);
      props.onApplyingChange(false);
    }
  }
  async function add(): Promise<void> {
    if (mode === "create") {
      const result = await operation.apply();
      if (!result) return;
      await props.setup.commands.refreshRegistry();
      rail?.canvas.onRefresh();
      if (result.status !== "applied" || result.receipt.publication?.state !== "pushed") return;
      toast?.show({ message: t("storefronts.createdToast", { name: creation?.name ?? "" }) });
      requestAnimationFrame(props.onClose);
      return;
    }
    if (locked.current || !inspection || !api?.linkStorefront) return;
    locked.current = true;
    setLinking(true);
    setError(null);
    props.onApplyingChange(true);
    try {
      const result = parseStorefrontLinkResult(await api.linkStorefront({ inspectionId: inspection.inspectionId }));
      if (result.status !== "linked") throw new Error(result.message);
      await props.setup.commands.refreshRegistry();
      rail?.canvas.onRefresh();
      toast?.show({ message: t("storefronts.linkedToast", { name: result.inspection.displayName }) });
      requestAnimationFrame(props.onClose);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("storefronts.unavailable"));
    } finally {
      locked.current = false;
      setLinking(false);
      props.onApplyingChange(false);
    }
  }
  const canAdd =
    mode === "link"
      ? Boolean(inspection && api?.linkStorefront)
      : operation.preview?.status === "ready" &&
        !operation.preview.plan.publication?.findings.length &&
        !operation.result;
  return (
    <SheetFrame
      title={t("addResource.marketplace")}
      kicker={
        <>
          {t("addResource.kicker")} <Glossary concept="marketplace" />
        </>
      }
      testId="canvas-setup-sheet"
      className="storefront-sheet add-resource-sheet"
      busy={busy}
      onClose={props.onClose}
      footer={
        <>
          <button className="canvas-secondary-button" disabled={busy} type="button" onClick={props.onClose}>
            {t("addResource.cancel")}
          </button>
          <span className="skill-footer-note" />
          <button
            className="canvas-secondary-button is-primary"
            type="button"
            disabled={busy || !canAdd || operation.checking}
            onClick={() => void add()}
          >
            {t(busy ? (mode === "create" ? "storefronts.createProgress" : "reviewExtras.loading") : "addResource.add")}
          </button>
        </>
      }
    >
      <div className="storefront-field">
        <div className="new-skill-segment">
          <button type="button" disabled={busy} aria-pressed={false} onClick={props.onExternal}>
            {t("addResource.external")}
          </button>
          <button type="button" disabled={busy} aria-pressed={true}>
            {t("storefronts.addTab")}
          </button>
        </div>
      </div>
      <p className="sh-sub">
        {t("storefronts.addHint", { workshop: "{workshop}" })
          .split("{workshop}")
          .map((part, index) =>
            index ? (
              <span key={index}>
                <b>{workshop}</b>
                {part}
              </span>
            ) : (
              part
            ),
          )}{" "}
        <Glossary concept="storefront" />
      </p>
      <div className="storefront-field">
        <div className="new-skill-segment">
          {(["link", "create"] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={busy}
              aria-pressed={mode === value}
              onClick={() => {
                setMode(value);
                setError(null);
              }}
            >
              {t(value === "link" ? "storefronts.link" : "storefronts.create")}
            </button>
          ))}
        </div>
      </div>
      {mode === "link" ? (
        <>
          <div className="storefront-field">
            <span className="storefront-label">{t("storefronts.storefrontFolder")}</span>
            <div className="storefront-folder-picker">
              <button
                className="canvas-secondary-button"
                type="button"
                disabled={busy || !api?.inspectStorefront}
                onClick={() => void inspect()}
              >
                {t("addResource.choose")}
              </button>
              <span className="sh-sub">
                {inspection?.displayRoot ?? inspection?.displayName ?? t("addResource.none")}
              </span>
            </div>
          </div>
          {inspection ? (
            <section className="sec">
              <h3>{t("addResource.found")}</h3>
              <dl className="storefront-kv">
                <dt>{t(inspection.githubRepository ? "storefronts.github" : "storefronts.repository")}</dt>
                <dd>
                  {storefrontDestination(inspection) || t("addResource.notFound")}
                  {inspection.githubRepository ? ` · ${t("storefronts.repositoryPublic")}` : ""}
                </dd>
                <dt>{t("storefronts.license")}</dt>
                <dd>{inspection.license ?? inspection.licenseFile ?? t("addResource.notFound")}</dd>
                <dt>{t("storefronts.inspectionPlugins")}</dt>
                <dd>
                  {inspection.plugins.map((plugin) => (
                    <div key={plugin.pluginId}>
                      {plugin.recognition === "recognized"
                        ? t("storefronts.recognized", { plugin: plugin.name, origin: "{origin}" })
                            .split("{origin}")
                            .map((part, index) =>
                              index ? (
                                <span key={index}>
                                  <b>
                                    {workshop} › {plugin.origin?.sourcePath.split("/").at(-1) ?? ""}
                                  </b>
                                  {part}
                                </span>
                              ) : (
                                part
                              ),
                            )
                        : t("storefronts.unrecognized", { plugin: plugin.name })}
                      {plugin.driftDiagnostic ? <small role="alert">{plugin.driftDiagnostic}</small> : null}
                    </div>
                  ))}
                </dd>
                {inspection.plugins.some((plugin) => plugin.behindSkills !== undefined) ? (
                  <>
                    <dt>{t("storefronts.inspectionDrift")}</dt>
                    <dd>
                      {inspection.plugins
                        .filter((plugin) => plugin.behindSkills !== undefined)
                        .map((plugin) => (
                          <div key={plugin.pluginId}>
                            {t("storefronts.inspectionBehind", { count: plugin.behindSkills! })}
                          </div>
                        ))}
                    </dd>
                  </>
                ) : null}
              </dl>
              <p className="sh-sub">{t("storefronts.readOnly")}</p>
            </section>
          ) : null}
        </>
      ) : (
        <>
          <NewStorefrontFields purpose="create" api={api} busy={busy} onChange={onChange} />
          <p className="sh-sub">{t("storefronts.emptyUntil")}</p>
          {operation.preview?.plan?.publication ? (
            <PublicationChecks
              summary={operation.preview.plan.publication}
              count={0}
              license={creation?.license ?? ""}
              isNew
              busy={busy || operation.checking}
              onRecheck={() => void operation.recheck()}
            />
          ) : null}
          {operation.preview?.plan ? (
            <section className="sec">
              <h3>{t("storefronts.effects")}</h3>
              <p className="sh-sub">{t("storefronts.createEffect", { repository })}</p>
              <ul>
                {operation.preview.plan.actions.map((action) => (
                  <li key={action.relativePath}>
                    <code>{action.relativePath}</code>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {operation.checking ? <p role="status">{t("storefronts.checking")}</p> : null}
          {operation.preview?.status === "blocked" ? <p role="alert">{operation.preview.diagnostic}</p> : null}
          {operation.result ? (
            <p role="alert">
              {t(
                operation.result.receipt.publication?.state === "committed-not-pushed"
                  ? "storefronts.notPushed"
                  : "storefronts.applyError",
              )}{" "}
              {operation.result.receipt.diagnostic}
            </p>
          ) : null}
        </>
      )}
      {error || operation.error ? <p role="alert">{error ?? operation.error}</p> : null}
    </SheetFrame>
  );
}
