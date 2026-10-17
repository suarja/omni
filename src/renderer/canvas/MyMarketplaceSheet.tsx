import { LoadingSkeleton } from "../components/ui/Skeleton";
import { useCanvasRail } from "./rail/rail-context";
import { PluginPublicationActions, PluginPublicationChips } from "./storefronts/PluginPublicationActions";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useI18n, tCount } from "../i18n";
import type { ResourceCanvasProps } from "./resource-canvas-types";
import { type PersonalPlugin } from "./personal-marketplace";
import { SheetFrame } from "./SheetFrame";
import { Glossary } from "./Glossary";
import { AnchoredFloating } from "./AnchoredFloating";
import { usePersonalMarketplace } from "./use-personal-marketplace";
import { useCanvasToast } from "./CanvasToast";
import "./skill-actions.css";

export function MyMarketplaceSheet(
  props: Readonly<{
    canvas: ResourceCanvasProps;
    onClose: () => void;
    onNewSkill: () => void;
    onApplyingChange: (active: boolean) => void;
  }>,
): ReactElement {
  const { t, language } = useI18n();
  const toast = useCanvasToast();
  const rail = useCanvasRail();
  const local = usePersonalMarketplace(props.canvas, rail ? "cached" : "observe");
  const { marketplace, error: readError, loading, reload } = rail?.personal ?? local;
  const [selection, setSelection] = useState<Readonly<{ plugin: PersonalPlugin; anchor: HTMLElement }> | null>(null);
  const [description, setDescription] = useState("");
  const [described, setDescribed] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false),
    cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, [selection]);
  function closePopover(): void {
    if (locked.current) return;
    const anchor = selection?.anchor;
    setSelection(null);
    setError(null);
    requestAnimationFrame(() => anchor?.isConnected && anchor.focus());
  }
  async function undo(operationId: string, plugin: PersonalPlugin): Promise<void> {
    if (locked.current || !props.canvas.api?.previewOperation || !props.canvas.api.applyOperation) return;
    locked.current = true;
    setBusy(true);
    props.onApplyingChange(true);
    try {
      const preview = await props.canvas.api.previewOperation({ kind: "restore-import", operationId });
      if (preview.status !== "ready") throw new Error(preview.diagnostic);
      const result = await props.canvas.api.applyOperation({ planId: preview.plan.planId });
      if (result.status !== "applied") throw new Error(result.receipt.diagnostic ?? t("projectView.partial"));
      setDescribed((current) => ({ ...current, [plugin.id]: plugin.description ?? "" }));
      await reload();
      props.canvas.onRefresh();
      toast.show({ message: t("projectView.undone") });
    } catch (error) {
      setError(error instanceof Error ? error.message : t("projectView.operationFailed"));
    } finally {
      locked.current = false;
      setBusy(false);
      props.onApplyingChange(false);
    }
  }
  async function save(): Promise<void> {
    if (
      locked.current ||
      !selection ||
      !marketplace ||
      !description.trim() ||
      !props.canvas.api?.previewOperation ||
      !props.canvas.api.applyOperation
    )
      return;
    const { plugin, anchor } = selection;
    locked.current = true;
    setBusy(true);
    setError(null);
    props.onApplyingChange(true);
    try {
      if (!(await props.canvas.onEnsureGrant(marketplace.source.ref)))
        throw new Error(t("projectView.operationUnavailable"));
      const preview = await props.canvas.api.previewOperation({
        kind: "describe-plugin",
        packageId: plugin.id,
        description,
      });
      if (preview.status !== "ready") throw new Error(preview.diagnostic);
      const result = await props.canvas.api.applyOperation({ planId: preview.plan.planId });
      if (result.status !== "applied") throw new Error(result.receipt.diagnostic ?? t("projectView.partial"));
      setDescribed((current) => ({ ...current, [plugin.id]: description.trim() }));
      setSelection(null);
      await reload();
      props.canvas.onRefresh();
      toast.show({
        message: t("skillActions.describedToast", { name: plugin.name }),
        undo: () => undo(result.receipt.operationId, plugin),
      });
      requestAnimationFrame(() => anchor.isConnected && anchor.focus());
    } catch (error) {
      setError(error instanceof Error ? error.message : t("projectView.operationFailed"));
    } finally {
      locked.current = false;
      setBusy(false);
      props.onApplyingChange(false);
    }
  }
  const git = marketplace?.inventory?.gitScopes;
  const gitLabel = git?.length
    ? git.some((scope) => scope.dirty === true)
      ? "skillActions.gitDirty"
      : git.every((scope) => scope.dirty === false)
        ? "skillActions.gitCurrent"
        : "skillActions.gitUnknown"
    : "skillActions.gitUnknown";
  return (
    <>
      <SheetFrame
        title={marketplace?.source.displayName ?? t("projectView.marketplace")}
        kicker={
          <>
            {t("projectView.marketplace")} <Glossary concept="marketplace" />
          </>
        }
        subtitle={
          loading && !marketplace?.inventory
            ? undefined
            : marketplace && !readError
              ? `${marketplace.source.displayRoot} · ${t(marketplace.inventory?.marketplace?.visibility === "public" ? "skillActions.public" : "skillActions.private")} · ${t(gitLabel)}`
              : undefined
        }
        testId="my-marketplace-sheet"
        className="marketplace-sheet"
        busy={busy}
        onClose={props.onClose}
        footer={
          <>
            <span className="skill-footer-note">{t("skillActions.marketplaceNote")}</span>
            <button
              type="button"
              className="canvas-secondary-button is-primary"
              disabled={busy || loading || Boolean(readError)}
              onClick={props.onNewSkill}
            >
              {t("skillActions.newSkillAction")}
            </button>
          </>
        }
      >
        <section className="project-sheet-section">
          {loading && !marketplace?.inventory ? (
            <LoadingSkeleton label={t("skillActions.marketplaceLoading")} variant="rows" />
          ) : readError ? null : (
            <>
              <h3>
                {t("skillActions.plugins", { count: marketplace?.plugins.length ?? 0 })} <Glossary concept="plugin" />
              </h3>
              {!marketplace?.inventory ? (
                <p>{t("canvas.notRead")}</p>
              ) : (
                <div className="skill-rows">
                  {marketplace.plugins.map((plugin) => {
                    const description = described[plugin.id] ?? plugin.description;
                    return (
                      <div className="skill-row" key={plugin.id}>
                        <div>
                          <b>{plugin.name}</b>
                          <small title={description}>
                            {tCount("skillActions.skills", plugin.count, {}, language)} —{" "}
                            {description || (
                              <span className="skill-missing-description">{t("skillActions.noDescription")}</span>
                            )}
                          </small>
                          <PluginPublicationChips plugin={plugin} />
                        </div>
                        <PluginPublicationActions
                          plugin={{ ...plugin, description }}
                          busy={busy}
                          onDescribe={(anchor) => {
                            setDescription("");
                            setError(null);
                            setSelection({ plugin, anchor });
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
        {(readError || error) && !selection ? (
          <p role="alert" className="skill-error">
            {readError ?? error}
          </p>
        ) : null}
      </SheetFrame>
      {selection ? (
        <AnchoredFloating
          anchor={selection.anchor}
          kind="pop"
          className="skill-description-pop"
          label={t("skillActions.describeTitle", { name: selection.plugin.name })}
          busy={busy}
          onClose={closePopover}
        >
          <h4>{t("skillActions.describeTitle", { name: selection.plugin.name })}</h4>
          <p>{t("skillActions.describeHint")}</p>
          <input
            className="skill-input"
            aria-label={t("skillActions.pluginDescription")}
            placeholder={t("skillActions.describePlaceholder")}
            value={description}
            disabled={busy}
            maxLength={1024}
            onChange={(event) => setDescription(event.target.value)}
          />
          {error ? (
            <p role="alert" className="skill-error">
              {error}
            </p>
          ) : null}
          <div className="project-sheet-actions">
            <button
              ref={cancel}
              type="button"
              className="canvas-secondary-button is-small"
              disabled={busy}
              onClick={closePopover}
            >
              {t("projectView.cancel")}
            </button>
            <button
              type="button"
              className="canvas-secondary-button is-small is-primary"
              disabled={busy || !description.trim() || /[\r\n\u0000-\u001f]/u.test(description)}
              onClick={() => void save()}
            >
              {t("skillActions.save")}
            </button>
          </div>
        </AnchoredFloating>
      ) : null}
    </>
  );
}
