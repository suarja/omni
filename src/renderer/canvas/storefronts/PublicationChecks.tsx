import { displayPluginFile } from "./presentation-model";
import type { ReactElement } from "react";
import type { PublicationPlanSummary } from "../../../shared/publication-operations-ipc";
import { useI18n } from "../../i18n";
import { Glossary } from "../Glossary";

export function PublicationChecks(
  props: Readonly<{
    summary?: PublicationPlanSummary;
    count: number;
    license: string;
    isNew: boolean;
    busy: boolean;
    onCopy?: () => void;
    onRecheck: () => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const groups = [
    {
      codes: ["non-english"],
      title: t("storefronts.english"),
      hint: t("storefronts.englishHint", { count: props.count }),
    },
    { codes: ["personal-path"], title: t("storefronts.paths"), hint: "" },
    { codes: ["secret", "email"], title: t("storefronts.secrets"), hint: t("storefronts.secretsHint") },
    {
      codes: ["license-missing"],
      title: t("storefronts.licenseCheck", { license: props.license }),
      hint: t(props.isNew ? "storefronts.newLicense" : "storefronts.existingLicense"),
    },
    { codes: ["skill-invalid"], title: t("storefronts.validSkills"), hint: t("storefronts.validSkillsHint") },
  ];
  const known = groups.flatMap((group) => group.codes);
  return (
    <section className="sec">
      <h3>
        {t("storefronts.checks")} <Glossary concept="checks" />
      </h3>
      {groups.map((group, index) => {
        const pending = !props.summary && index !== 3;
        const findings = (props.summary?.findings ?? []).filter(
          (finding) =>
            group.codes.includes(finding.code) || (index === groups.length - 1 && !known.includes(finding.code)),
        );
        return (
          <div
            className={`storefront-check${findings.length ? " is-blocked" : pending ? " is-pending" : ""}`}
            key={group.codes[0]}
          >
            <span className="mark" aria-hidden="true">
              {findings.length ? "✕" : pending ? "•" : "✓"}
            </span>
            <div className="grow">
              <b>
                {findings.length
                  ? t(index === 1 ? "storefronts.pathsBlocked" : "storefronts.blockedCheck", { count: findings.length })
                  : group.title}
              </b>
              {group.hint || (findings.length && index === 1) ? (
                <small>{findings.length && index === 1 ? t("storefronts.pathsHint") : group.hint}</small>
              ) : null}
              {findings.length ? (
                <>
                  <div className="storefront-findings">
                    {findings.map((finding, i) => (
                      <div key={`${finding.file}:${finding.line}:${i}`}>
                        <code title={finding.file}>{displayPluginFile(finding.file)}</code>{" "}
                        {t("storefronts.line", { line: finding.line })} · <code>{finding.excerpt}</code>
                      </div>
                    ))}
                  </div>
                  <div className="storefront-check-actions">
                    {props.onCopy ? (
                      <button
                        className="canvas-secondary-button is-small"
                        disabled={props.busy}
                        type="button"
                        onClick={props.onCopy}
                      >
                        {t("storefronts.correctAgent")}
                      </button>
                    ) : null}
                    <button
                      className="canvas-secondary-button is-small is-ghost"
                      type="button"
                      disabled={props.busy}
                      onClick={props.onRecheck}
                    >
                      {t("storefronts.recheck")}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
