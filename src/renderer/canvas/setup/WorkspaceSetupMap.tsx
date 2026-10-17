import type { CSSProperties, ReactElement } from "react";
import iconUrl from "../../../../resources/brand/icon.svg?url";
import markUrl from "../../../../resources/brand/mark.svg?url";
import { agentName } from "../../agents/agent-utils";
import { useI18n } from "../../i18n";
import { LoadingSkeleton } from "../../components/ui/Skeleton";
import { CanvasGlyph } from "../CanvasGlyph";
import { Icon } from "../../components/Icon";
import type { WorkspaceMapGeometry, WorkspaceSetupPlace } from "./workspace-map-layout";
import type { WorkspaceMapState } from "./use-workspace-map";
import "./workspace-map.css";

export type WorkspaceMapIntent = "create-marketplace" | "connect-marketplace" | "project" | "agents";
type MapProps = Readonly<{
  state: WorkspaceMapState;
  geometry: WorkspaceMapGeometry;
  loading: boolean;
  available: boolean;
  onSetup: (intent: WorkspaceMapIntent, opener: HTMLElement) => void;
}>;

export function WorkspaceSetupHeader({ state }: Readonly<{ state: WorkspaceMapState }>): ReactElement {
  const { t } = useI18n();
  const count = state.progress.count;
  return (
    <section className={`workspace-setup-header${count ? " is-compact" : ""}`} aria-live="polite">
      {!count ? (
        <>
          <img src={iconUrl} alt="" width={40} height={40} />
          <h1>{t("canvasSetup.welcomeTitle")}</h1>
          <p>{t("canvasSetup.welcomeDescription")}</p>
        </>
      ) : null}
      <div className="workspace-setup-progress" data-testid="workspace-setup-progress">
        {count ? <span>{t("canvasSetup.setupProgress", { count })}</span> : null}
        <span className="workspace-setup-segments" aria-hidden="true">
          {(["marketplace", "project", "agents"] as const).map((step) => (
            <i key={step} data-done={state.progress.done[step]} />
          ))}
        </span>
        {!count ? <span>{t("canvasSetup.progress", { count })}</span> : null}
        {count ? (
          <button
            className="workspace-setup-hide"
            data-testid="workspace-setup-hide"
            type="button"
            disabled={!state.canSave || state.saving}
            onClick={() => void state.setHidden(true)}
          >
            {t("canvasSetup.hideSetup")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function placeStyle(place: WorkspaceSetupPlace): CSSProperties {
  return {
    left: place.x - place.width / 2,
    top: place.y - place.height / 2,
    width: place.width,
    minHeight: place.height,
  };
}

function SetupPlace({ place, ...props }: MapProps & Readonly<{ place: WorkspaceSetupPlace }>): ReactElement {
  const { t } = useI18n();
  const step = place.step;
  const current = props.state.progress.current === step;
  const index = step === "marketplace" ? 1 : step === "project" ? 2 : 3;
  const action = (intent: WorkspaceMapIntent, label: string, primary = false): ReactElement => (
    <button
      className={`canvas-secondary-button${primary ? " is-primary" : ""}`}
      type="button"
      data-testid={`workspace-setup-${intent}`}
      disabled={!props.available}
      title={!props.available ? t("canvasSetup.apiUnavailable") : undefined}
      onClick={(event) => props.onSetup(intent, event.currentTarget)}
    >
      {label}
    </button>
  );
  return (
    <section
      className={`workspace-setup-place${props.loading ? " is-loading" : ""}`}
      style={placeStyle(place)}
      data-setup-step={step}
      data-current={current}
      aria-labelledby={props.loading ? undefined : `workspace-setup-${step}-title`}
    >
      {props.loading ? (
        <LoadingSkeleton
          label={t("canvas.loadingSurface", { surface: t("canvas.workspace") })}
          variant="cards"
          rows={1}
        />
      ) : (
        <>
          <span className="workspace-setup-step">{t("canvasSetup.step", { count: index })}</span>
          <div className="workspace-setup-place-heading">
            <span className="canvas-node-icon" data-tone={step} aria-hidden="true">
              {step === "agents" ? <Icon name="agent" size={18} /> : <CanvasGlyph name={step} />}
            </span>
            <div>
              <h2 id={`workspace-setup-${step}-title`}>{t(`canvasSetup.places.${step}.title`)}</h2>
              <p>{t(`canvasSetup.places.${step}.subtitle`)}</p>
            </div>
          </div>
          {step !== "agents" ? (
            <p className="workspace-setup-place-copy">{t(`canvasSetup.places.${step}.description`)}</p>
          ) : null}
          <div className="workspace-setup-place-actions">
            {step === "marketplace" ? (
              <>
                {action("create-marketplace", t("canvasSetup.createMyMarketplace"), true)}
                {action("connect-marketplace", t("canvasSetup.connectMyMarketplace"))}
              </>
            ) : step === "project" ? (
              action("project", t("canvasSetup.addProject"))
            ) : (
              <>
                {action("agents", t("canvasSetup.connectAgents"))}
                {props.state.progress.detected.map((agent) => (
                  <span className="workspace-setup-agent-chip" key={agent.harness}>
                    {agentName(agent.harness)}
                  </span>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function WorkspaceSetupMap(props: MapProps): ReactElement {
  const { t } = useI18n();
  return (
    <div className="workspace-setup-map">
      {props.geometry.places.map((place) => (
        <SetupPlace {...props} place={place} key={place.step} />
      ))}
      {props.geometry.center ? (
        <div
          className="workspace-setup-center"
          role="img"
          aria-label="Omni"
          style={{ left: props.geometry.center.x - 75, top: props.geometry.center.y - 48 }}
        >
          <img src={markUrl} alt="" width={38} height={38} />
          <span>Omni</span>
        </div>
      ) : null}
      {props.geometry.agents && !props.loading ? (
        <div
          className="canvas-node-row workspace-connected-agents"
          data-tone="group"
          style={{ left: props.geometry.agents.x - 132, top: props.geometry.agents.y - 36 }}
        >
          <button
            type="button"
            className="canvas-node"
            data-testid="workspace-connected-agents"
            onClick={(event) => props.onSetup("agents", event.currentTarget)}
          >
            <span className="canvas-node-icon" aria-hidden="true">
              <Icon name="agent" size={18} />
            </span>
            <span className="canvas-node-body">
              <span className="canvas-node-label">{t("canvasSetup.places.agents.title")}</span>
              <span className="canvas-node-meta">
                {props.state.progress.connected.map((agent) => agentName(agent.harness)).join(" · ")}
              </span>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
