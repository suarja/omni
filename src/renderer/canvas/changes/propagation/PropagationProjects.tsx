import type { ReactElement } from "react";
import type { SkillPropagationSummary } from "../../../../shared/skill-propagation-ipc";
import type { TranslationFunction } from "../../../i18n";
import { Icon } from "../../../components/Icon";
import type { buildPropagationView } from "./view-model";
import { PropagationDetails } from "./PropagationDetails";
import { harnessName, toneIcons } from "./labels";

export function PropagationProjects({
  summary,
  view,
  nameFor,
  t,
  disabled,
  onSelect,
}: Readonly<{
  summary: SkillPropagationSummary;
  view: ReturnType<typeof buildPropagationView>;
  nameFor: (id: string) => string;
  t: TranslationFunction;
  disabled: boolean;
  onSelect: (key: string, selected: boolean) => void;
}>): ReactElement {
  return (
    <section className="propagation-projects" data-testid="changes-propagation-projects">
      <p className="changes-note">
        {t("skillManagement.propagationCounts", { projects: view.projectCount, copies: view.copyCount })}
      </p>
      {(["safe", "retained", "unavailable"] as const).map((group) => {
        const locations = view.locations.filter((item) => item.group === group);
        return locations.length ? (
          <section key={group}>
            <h3>
              {t(
                group === "safe"
                  ? "skillManagement.propagationSafe"
                  : group === "retained"
                    ? "skillManagement.propagationStateRetained"
                    : "skillManagement.propagationStateUnavailable",
              )}
            </h3>
            {locations.map((item) => (
              <article className="propagation-project-row" key={item.key} data-tone={item.tone}>
                {item.selectable ? (
                  <input
                    type="checkbox"
                    aria-label={t("skillManagement.propagationSelect", {
                      project: nameFor(item.target.location.projectId),
                      harness: harnessName(item.target.location.harnessId),
                      folder: item.target.location.folderPath,
                    })}
                    checked={item.selected}
                    disabled={disabled}
                    onChange={(event) => onSelect(item.key, event.target.checked)}
                  />
                ) : (
                  <Icon name={toneIcons[item.tone]} />
                )}
                <span className="propagation-project-name">
                  {nameFor(item.target.location.projectId)}
                  <small>{harnessName(item.target.location.harnessId)}</small>
                  {item.target.reason ? <small>{item.target.reason}</small> : null}
                  <PropagationDetails summary={summary} target={item.target} t={t} />
                </span>
                <span className="propagation-project-status">
                  {t(
                    item.target.state === "already-current"
                      ? "skillManagement.propagationStateAlreadyCurrent"
                      : item.group === "safe"
                        ? item.target.state === "current"
                          ? "skillManagement.propagationStateCurrent"
                          : "skillManagement.propagationStateEligible"
                        : item.group === "retained"
                          ? "skillManagement.propagationStateRetained"
                          : "skillManagement.propagationStateUnavailable",
                  )}
                </span>
              </article>
            ))}
          </section>
        ) : null;
      })}
    </section>
  );
}
