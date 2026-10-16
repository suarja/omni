import { githubDestinationRepository, storefrontDestination } from "../../../domain/storefront-destination";
import { PublicationEffects } from "./PublicationEffects";
import { useContentChecks } from "./use-content-checks";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import type {
  NewStorefront,
  ConflictChoices,
  PublishPluginRequest,
  RetryPushRequest,
} from "../../../shared/publication-operations-ipc";
import { activeStorefronts, activeWorkshop } from "../../../domain/source-roles";
import { useI18n, tCount } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { usePersonalMarketplace } from "../use-personal-marketplace";
import { useCanvasToast } from "../CanvasToast";
import { SheetFrame } from "../SheetFrame";
import { Glossary } from "../Glossary";
import { NewStorefrontFields } from "./NewStorefrontFields";
import { PublicationChecks } from "./PublicationChecks";
import { PublicationFiles } from "./PublicationFiles";
import { usePublication } from "./use-publication";
import { pluginIdFor, publicationDate } from "./presentation-model";
import "./storefronts.css";
import "../new-skill.css";

export function PublishSheet(props: Readonly<{ onApplyingChange: (busy: boolean) => void }>): ReactElement | null {
  const rail = useCanvasRail();
  if (!rail) return null;
  return <PublicationForm key={JSON.stringify(rail.publishSelection)} onApplyingChange={props.onApplyingChange} />;
}
function PublicationForm(props: Readonly<{ onApplyingChange: (busy: boolean) => void }>): ReactElement {
  const rail = useCanvasRail()!;
  const { canvas, publishSelection } = rail;
  const { t, language } = useI18n(),
    toast = useCanvasToast();
  const { marketplace, loading, error: readError } = usePersonalMarketplace(canvas);
  const sources = activeStorefronts(canvas.snapshot.registry);
  const [pluginId, setPluginId] = useState(publishSelection.pluginId ?? "");
  const [storefrontId, setStorefrontId] = useState(publishSelection.storefrontId ?? sources[0]?.ref.id ?? "");
  const [isNew, setIsNew] = useState(
    Boolean(
      publishSelection.agentRequest?.request.kind === "publish-plugin" &&
      publishSelection.agentRequest.request.newStorefront,
    ) ||
      (!sources.length && !publishSelection.agentRequest),
  );
  const [newStorefront, setNewStorefront] = useState<NewStorefront | null>(
    publishSelection.agentRequest?.request.kind === "publish-plugin"
      ? (publishSelection.agentRequest.request.newStorefront ?? null)
      : null,
  );
  const [repository, setRepository] = useState("");
  const [draft, setDraft] = useState({
    name: "",
    license: "MIT" as "MIT" | "Apache-2.0",
    repositoryMode: "create" as "create" | "existing",
  });
  const [checkRevision, setCheckRevision] = useState(0);
  const content = useContentChecks(canvas.api, isNew ? pluginId : "", checkRevision);
  const [choices, setChoices] = useState<ConflictChoices>({});
  const [error, setError] = useState<string | null>(null);
  const plugin = marketplace?.plugins.find((plugin) => pluginIdFor(plugin.id) === pluginId);
  const source = sources.find((source) => source.ref.id === storefrontId);
  const details = rail.storefronts.details.get(storefrontId);
  const readyDetails = details?.status === "ready" ? details : undefined;
  const repo = isNew ? repository : storefrontDestination(readyDetails?.inspection);
  const destinationName = isNew
    ? draft.name || newStorefront?.name || t("storefronts.newDestinationName")
    : (source?.displayName ?? storefrontId);
  const update = Boolean(publishSelection.update),
    retry = publishSelection.retryOperationId;
  const onNewChange = useCallback(
    (
      value: NewStorefront | null,
      repository: string,
      draft: { name: string; license: "MIT" | "Apache-2.0"; repositoryMode: "create" | "existing" },
    ): void => {
      setDraft(draft);
      setNewStorefront(value);
      setRepository(repository);
    },
    [],
  );
  const request = useMemo<PublishPluginRequest | RetryPushRequest | null>(() => {
    if (retry) return { kind: "retry-push", operationId: retry };
    if (loading || readError || !pluginId || !plugin?.description) return null;
    if (publishSelection.agentRequest?.request.kind === "publish-plugin")
      return { ...publishSelection.agentRequest.request, conflictChoices: choices };
    if (isNew && newStorefront) return { kind: "publish-plugin", pluginId, newStorefront, conflictChoices: choices };
    return !isNew && storefrontId ? { kind: "publish-plugin", pluginId, storefrontId, conflictChoices: choices } : null;
  }, [
    retry,
    loading,
    readError,
    pluginId,
    plugin?.description,
    isNew,
    newStorefront,
    storefrontId,
    choices,
    publishSelection.agentRequest,
  ]);
  const operation = usePublication(canvas.api, request, publishSelection.agentRequest, props.onApplyingChange);
  const plan = operation.preview?.plan;
  const summary = plan?.publication ?? (isNew ? content.summary : null);
  const footerNote =
    operation.checking || (isNew && !summary && !content.error)
      ? "storefronts.checking"
      : summary?.findings.length
        ? "storefronts.blockedNote"
        : plan?.publication?.conflicts.length
          ? "storefronts.conflictNote"
          : isNew && !newStorefront
            ? "storefronts.newDestinationNote"
            : operation.preview?.status !== "ready"
              ? "storefronts.publicationPending"
              : "storefronts.publicWarning";
  async function recheck(): Promise<void> {
    setCheckRevision((value) => value + 1);
    await operation.recheck();
  }
  const blocked =
    operation.preview?.status !== "ready" ||
    !plan ||
    Boolean(plan.publication?.findings.length || plan.publication?.conflicts.length);
  const publication = readyDetails?.publications.find((publication) => publication.pluginId === pluginId);
  function back(): void {
    if (operation.busy) return;
    if (publishSelection.storefrontId) rail.openStorefront(publishSelection.storefrontId);
    else rail.close();
  }
  async function copyFindings(): Promise<void> {
    try {
      const findings =
        summary?.findings
          .map(
            (finding) =>
              `${finding.file}:${finding.line} ${finding.code}: ${finding.message} ${finding.excerpt} ${finding.fix}`,
          )
          .join("\n") ?? "";
      await navigator.clipboard.writeText(t("storefronts.fixPrompt", { plugin: pluginId, findings }));
      toast.show({ message: t("storefronts.copied") });
    } catch {
      setError(t("storefronts.copyFailed"));
    }
  }
  async function publish(): Promise<void> {
    const result = await operation.apply();
    if (!result) return;
    canvas.onRefresh();
    await rail.storefronts.reload();
    if (result.receipt.publication?.state !== "pushed" || result.status !== "applied") return;
    const publication = result.receipt.publication;
    const github = Boolean(githubDestinationRepository(publication.remoteUrl));
    toast.show({
      message: t(github ? "storefronts.toast" : "storefronts.toastPushed", {
        plugin: result.receipt.publication.pluginId ?? pluginId,
        storefront: destinationName,
      }),
      action: github
        ? {
            label: t("storefronts.viewGithub"),
            run: () => {
              void canvas.api
                ?.openStorefrontRepository?.({ sourceId: result.receipt.publication!.storefrontId })
                .then((response) => {
                  if (response.status !== "opened") toast.show({ message: response.message });
                })
                .catch(() => toast.show({ message: t("storefronts.unavailable") }));
            },
          }
        : undefined,
    });
    requestAnimationFrame(() => rail.openStorefront(publication.storefrontId));
  }
  const title = retry
    ? t("storefronts.retryPublish")
    : !pluginId
      ? t("storefronts.pickerTitle")
      : t(update ? "storefronts.update" : "storefronts.publishTitle");
  return (
    <SheetFrame
      title={title}
      kicker={
        <>
          {pluginId || t("storefronts.publish")} <Glossary concept="publish" />
        </>
      }
      subtitle={update ? t("storefronts.updateSubtitle", { name: destinationName }) : plugin?.description}
      testId="publish-sheet"
      className="storefront-sheet"
      busy={operation.busy}
      onClose={back}
      footer={
        <>
          <button className="canvas-secondary-button" type="button" disabled={operation.busy} onClick={back}>
            {t(update || retry ? "canvas.back" : "addResource.cancel")}
          </button>
          <span className="skill-footer-note">{pluginId || retry ? t(footerNote) : ""}</span>
          {pluginId || retry ? (
            <button
              className="canvas-secondary-button is-primary"
              type="button"
              disabled={blocked || operation.busy || operation.checking || Boolean(operation.result)}
              onClick={() => void publish()}
            >
              {t(
                operation.busy
                  ? "storefronts.publishing"
                  : update
                    ? "storefronts.update"
                    : retry
                      ? "storefronts.retry"
                      : "storefronts.publish",
              )}
            </button>
          ) : null}
        </>
      }
    >
      {loading ? <p role="status">{t("skillActions.marketplaceLoading")}</p> : null}
      {!pluginId && !retry ? (
        <>
          <p className="sh-sub">{t("storefronts.pickerHint")}</p>
          <div className="storefront-pickwrap storefront-plugin-picker">
            {marketplace?.plugins.map((plugin) => (
              <label className="storefront-pick" key={plugin.id}>
                <input
                  type="radio"
                  name="publish-plugin"
                  disabled={!plugin.description || operation.busy}
                  onChange={() => setPluginId(pluginIdFor(plugin.id))}
                />
                <span>
                  <b>{plugin.name}</b>
                  <small>
                    {tCount("skillActions.skills", plugin.count, {}, language)} —{" "}
                    {plugin.description ?? (
                      <span className="skill-missing-description">{t("storefronts.describeFirst")}</span>
                    )}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </>
      ) : (
        <>
          {retry ? (
            <p className="sh-sub">{t("storefronts.retryWarning")}</p>
          ) : update && plan ? (
            <PublicationFiles
              plan={plan}
              date={publicationDate(publication?.publishedTime, language)}
              choices={choices}
              busy={operation.busy}
              onChoose={(path, choice) => setChoices((current) => ({ ...current, [path]: choice }))}
            />
          ) : !publishSelection.agentRequest ? (
            <div className="storefront-field">
              <span className="storefront-label">
                {t("storefronts.destination")} <Glossary concept="storefront" />
              </span>
              <div className="storefront-pickwrap">
                {sources.map((source) => {
                  const detail = rail.storefronts.details.get(source.ref.id);
                  return (
                    <label className="storefront-pick" key={source.ref.id}>
                      <input
                        type="radio"
                        name="storefront"
                        checked={!isNew && storefrontId === source.ref.id}
                        disabled={operation.busy}
                        onChange={() => {
                          setIsNew(false);
                          setStorefrontId(source.ref.id);
                          setChoices({});
                        }}
                      />
                      <span>
                        <b>{source.displayName}</b>
                        <small>
                          {detail?.status === "ready" ? storefrontDestination(detail.inspection) : ""} ·{" "}
                          {t("storefronts.public")} ·{" "}
                          {tCount(
                            "storefronts.plugins",
                            detail?.status === "ready" ? detail.inspection.plugins.length : 0,
                            {},
                            language,
                          )}
                        </small>
                      </span>
                    </label>
                  );
                })}
                <label className="storefront-pick">
                  <input
                    type="radio"
                    name="storefront"
                    checked={isNew}
                    disabled={operation.busy}
                    onChange={() => {
                      setIsNew(true);
                      setChoices({});
                    }}
                  />
                  <span>
                    <b>{t("storefronts.newStorefront")}</b>
                    <small>{t("storefronts.newStorefrontHint")}</small>
                  </span>
                </label>
              </div>
              {isNew ? (
                <NewStorefrontFields purpose="publish" api={canvas.api} busy={operation.busy} onChange={onNewChange} />
              ) : null}
            </div>
          ) : null}
          {summary || isNew ? (
            <PublicationChecks
              summary={summary ?? undefined}
              count={plugin?.count ?? 0}
              license={isNew ? draft.license : (readyDetails?.license ?? t("canvas.notRead"))}
              isNew={isNew}
              busy={operation.busy || operation.checking}
              onCopy={() => void copyFindings()}
              onRecheck={() => void recheck()}
            />
          ) : null}
          {plan || isNew ? (
            <PublicationEffects
              destination={destinationName}
              repository={repo}
              github={isNew || Boolean(readyDetails?.inspection.githubRepository)}
              pluginId={pluginId}
              workshop={activeWorkshop(canvas.snapshot.registry)?.displayName ?? ""}
              mode={
                retry
                  ? "retry"
                  : isNew
                    ? draft.repositoryMode === "existing"
                      ? "new-existing"
                      : "new"
                    : update
                      ? "update"
                      : "publish"
              }
              changedFiles={plan?.publication?.files.filter((file) => file.classification !== "unchanged").length ?? 0}
              retryTarget={plan?.displayTarget}
            />
          ) : null}
          {isNew && !plan && content.error ? (
            <p role="alert">
              {t("storefronts.checkingFailed")}{" "}
              <button type="button" className="canvas-secondary-button is-small" onClick={() => void recheck()}>
                {t("storefronts.recheck")}
              </button>
            </p>
          ) : null}
          {operation.checking || operation.busy ? (
            <p role="status">{t(operation.busy ? "storefronts.publishing" : "storefronts.checking")}</p>
          ) : null}
          {operation.preview?.status === "blocked" && !plan?.publication?.findings.length ? (
            <p role="alert">
              {operation.preview.diagnostic}{" "}
              <button
                className="canvas-secondary-button is-small"
                type="button"
                onClick={() => void operation.recheck()}
              >
                {t("storefronts.recheck")}
              </button>
            </p>
          ) : null}
          {operation.result ? (
            <div className="storefront-callout is-warn" role="alert">
              <div className="grow">
                <b>
                  {t(
                    operation.result.receipt.publication?.state === "committed-not-pushed"
                      ? "storefronts.notPushed"
                      : operation.result.receipt.publication?.state === "push-outcome-unknown"
                        ? "storefronts.pushUnknown"
                        : "storefronts.applyError",
                  )}
                </b>
                <small>{operation.result.receipt.diagnostic}</small>
              </div>
              {operation.result.receipt.publication &&
              ["committed-not-pushed", "push-outcome-unknown"].includes(operation.result.receipt.publication.state) ? (
                <button
                  className="canvas-secondary-button is-small"
                  type="button"
                  onClick={() =>
                    rail.openPublish({
                      storefrontId: operation.result!.receipt.publication!.storefrontId,
                      retryOperationId: operation.result!.receipt.operationId,
                    })
                  }
                >
                  {t("storefronts.retry")}
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {readError || error || operation.error ? (
        <p role="alert">
          {readError ?? error ?? operation.error}
          {operation.error ? (
            <button type="button" className="canvas-secondary-button is-small" onClick={() => void operation.recheck()}>
              {t("storefronts.recheck")}
            </button>
          ) : null}
        </p>
      ) : null}
    </SheetFrame>
  );
}
