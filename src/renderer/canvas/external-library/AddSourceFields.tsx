import { licenceLabel } from "./presentation";
import { discoverMacSource, useMacDiscovery } from "./use-mac-discovery";
import { parseExternalDiscovery, type ExternalDiscovery } from "../../../shared/external-library-ui-ipc";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { parseExternalRepository } from "../../../domain/external-library";
import { parseExternalSourceAddResult, type ExternalSourceDetails } from "../../../shared/external-library-ipc";
import { useI18n, translateCount } from "../../i18n";
import { useCanvasRail } from "../rail/rail-context";
import { Glossary } from "../Glossary";
import { useOptionalCanvasToast } from "../CanvasToast";
import { formatSourceDate } from "./presentation";

export function AddSourceFields(
  props: Readonly<{
    onFolder: () => void;
    folderAvailable: boolean;
    folderBusy?: boolean;
    onApplyingChange: (busy: boolean) => void;
    initialRepository?: string;
    actionTarget?: HTMLElement | null;
  }>,
): ReactElement {
  const rail = useCanvasRail();
  const { t, language } = useI18n();
  const toast = useOptionalCanvasToast();
  const [repository, setRepository] = useState(props.initialRepository ?? "");
  const [discoveryInput, setDiscoveryInput] = useState(props.initialRepository ?? "");
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  function requestDiscovery(repository: string): void {
    setDiscoveryInput(repository);
    setDiscoveryAttempt((current) => current + 1);
  }
  const [found, setFound] = useState<ExternalSourceDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addedSourceId, setAddedSourceId] = useState<string | null>(null);
  const navigationBlocked = rail?.blocked.current ?? true;
  const locked = useRef(false);
  const [discovering, setDiscovering] = useState(false);
  const macDetails = useMacDiscovery(rail?.canvas.api, rail?.externalLibrary.mac);
  const generation = useRef(0);
  useEffect(() => {
    const ticket = ++generation.current;
    setFound(null);
    setError(null);
    setDiscovering(false);
    try {
      const repo = parseExternalRepository(discoveryInput);
      const known = rail?.externalLibrary.details.get(repo);
      if (known?.source && !known.source.lastError) {
        setFound(known);
        return;
      }
      if (!rail?.canvas.api?.discoverExternalSource) return;
      setDiscovering(true);
      const discovery = rail.externalLibrary.mac?.marketplaces.some((item) => item.repo === repo)
        ? discoverMacSource(rail.canvas.api, rail.externalLibrary.mac, repo)
        : rail.canvas.api.discoverExternalSource({ repository: repo });
      void discovery
        .then((raw) => {
          if (ticket !== generation.current) return;
          const result = parseExternalDiscovery(raw);
          if (result.status === "failed") setError(result.error.message);
          else setFound({ source: result.source, skills: result.skills, uses: result.uses });
        })
        .catch((failure: unknown) => {
          if (ticket === generation.current)
            setError(failure instanceof Error ? failure.message : "Source discovery failed.");
        })
        .finally(() => {
          if (ticket === generation.current) setDiscovering(false);
        });
    } catch {
      /* Incomplete input is kept for editing. */
    }
    return () => {
      generation.current++;
    };
  }, [discoveryInput, discoveryAttempt, rail?.externalLibrary.details, rail?.canvas.api]);
  useEffect(() => {
    if (!addedSourceId || busy || navigationBlocked || !rail || rail.blocked.current) return;
    setAddedSourceId(null);
    rail.openExternalDestination({ sourceId: addedSourceId, view: "source", filter: "unused" });
  }, [addedSourceId, busy, navigationBlocked, rail]);
  async function add(): Promise<void> {
    if (locked.current || !found || !rail?.canvas.api?.addExternalSource) return;
    locked.current = true;
    setBusy(true);
    props.onApplyingChange(true);
    try {
      const response = parseExternalSourceAddResult(await rail.canvas.api.addExternalSource({ repository }));
      if (response.status !== "added" || !response.source)
        throw new Error(response.error?.message ?? "Source addition failed. Check the repository and try again.");
      await rail.externalLibrary.reload();
      toast?.show({
        message: translateCount(t, "externalLibrary.added", response.source.skillCount, {
          source: response.source.name,
        }),
      });
      setAddedSourceId(response.source.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Source addition failed.");
    } finally {
      locked.current = false;
      setBusy(false);
      props.onApplyingChange(false);
    }
  }
  const addAction = (
    <button
      type="button"
      className="canvas-secondary-button is-primary"
      disabled={busy || !found || !rail?.canvas.api?.addExternalSource}
      onClick={() => void add()}
    >
      {t("externalLibrary.add")}
    </button>
  );
  return (
    <div className="external-library-sheet" data-testid="external-add-fields">
      <div className="skill-field">
        <label className="skill-label" htmlFor="external-repository">
          {t("externalLibrary.githubField")}
        </label>
        <input
          className="external-find"
          id="external-repository"
          placeholder={t("externalLibrary.githubPlaceholder")}
          value={repository}
          disabled={busy}
          onChange={(event) => {
            setRepository(event.target.value);
            setDiscoveryInput("");
            setFound(null);
          }}
          onBlur={(event) => requestDiscovery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              requestDiscovery(event.currentTarget.value);
            }
          }}
        />
        <small className="skill-hint">
          {t("externalLibrary.addHint")} <Glossary concept="readcopy" />
        </small>
      </div>
      <div className="skill-field">
        <span className="skill-label">
          {t("externalLibrary.onMac")} <Glossary concept="onmac" />
        </span>
        <div className="external-options">
          {rail?.externalLibrary.mac?.marketplaces
            .filter(
              (item) =>
                !rail.externalLibrary.list?.sources.some(
                  (source) => source.repo?.toLowerCase() === item.repo.toLowerCase(),
                ),
            )
            .map((item) => (
              <label className="external-option" key={item.repo}>
                <input
                  type="radio"
                  name="external-mac-source"
                  checked={repository.toLowerCase() === item.repo.toLowerCase()}
                  disabled={busy}
                  onChange={() => {
                    setRepository(item.repo);
                    requestDiscovery(item.repo);
                  }}
                />
                <span>
                  <b>{item.repo}</b>
                  <small>
                    {t("externalLibrary.macMarketplace", { name: item.id })}
                    {macDetails.get(item.repo)?.status === "ready"
                      ? ` · ${
                          (macDetails.get(item.repo) as Extract<ExternalDiscovery, { status: "ready" }>).skills
                            .length === 0
                            ? t("externalLibrary.commandsOnly")
                            : translateCount(
                                t,
                                "externalLibrary.skillCount",
                                (macDetails.get(item.repo) as Extract<ExternalDiscovery, { status: "ready" }>).skills
                                  .length,
                              )
                        }`
                      : ""}
                  </small>
                </span>
              </label>
            ))}
        </div>
      </div>
      {discovering ? <p role="status">{t("externalLibrary.checking")}</p> : null}
      {found?.source ? (
        <section className="external-section">
          <h3>{t("externalLibrary.discovery")}</h3>
          <dl className="external-kv">
            <dt>{t("externalLibrary.github")}</dt>
            <dd>{found.source.repo}</dd>
            <dt>{t("externalLibrary.licence")}</dt>
            <dd>{licenceLabel(found.source.licence, t)}</dd>
            <dt>Skills</dt>
            <dd>
              {t("externalLibrary.discoverySkills", {
                count: found.skills.length,
                date: formatSourceDate(found.source.head?.date, language),
              })}
            </dd>
            <dt>{t("externalLibrary.yourProjects")}</dt>
            <dd>
              {found.source.projects.map((project) => project.name).join(", ") || t("externalLibrary.discoveryNoUses")}
            </dd>
            {rail?.externalLibrary.mac?.marketplaces.some(
              (item) => item.repo.toLowerCase() === found.source!.repo?.toLowerCase(),
            ) ? (
              <>
                <dt>Claude Code</dt>
                <dd>
                  {t("externalLibrary.claudeMarketplace", {
                    plugins: rail.externalLibrary.mac.marketplaces
                      .filter((item) => item.repo.toLowerCase() === found.source!.repo?.toLowerCase())
                      .map((item) => item.id)
                      .join(", "),
                  })}
                </dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : repository && !discovering ? (
        <p role="status">{t("externalLibrary.discoveryUnavailable")}</p>
      ) : null}
      <div className="external-actions">
        <button
          type="button"
          className="canvas-secondary-button"
          data-testid="canvas-setup-connect-source"
          disabled={busy || props.folderBusy || !props.folderAvailable}
          onClick={props.onFolder}
        >
          {t("externalLibrary.folder")}
        </button>
        {props.actionTarget ? createPortal(addAction, props.actionTarget) : addAction}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
