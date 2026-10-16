import { displayPluginFile } from "./presentation-model";
import { useState, type ReactElement } from "react";
import type { OperationPlan } from "../../../shared/operations-ipc";
import type { ConflictChoices } from "../../../shared/publication-operations-ipc";
import { useI18n } from "../../i18n";
import { DiffLines } from "../changes/DiffLines";
import { parseDiffLines } from "../changes/diff-lines";
import "../changes/changes.css";

export function PublicationFiles(
  props: Readonly<{
    plan: OperationPlan;
    date: string;
    choices: ConflictChoices;
    busy: boolean;
    onChoose: (path: string, choice: "keep-storefront" | "take-workshop") => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <section className="sec">
      <h3>{t("storefronts.filesChanged", { date: props.date })}</h3>
      <div className="storefront-rows">
        {props.plan.publication?.files
          .filter((file) => file.classification !== "unchanged")
          .map((file) => {
            const diff = props.plan.actions.find((action) => action.relativePath.endsWith(`/${file.path}`))?.diff;
            const lines = diff ? parseDiffLines(diff) : undefined;
            return (
              <div key={file.path}>
                <div className="storefront-row">
                  <div className="rn">
                    <b title={file.path}>{displayPluginFile(file.path)}</b>
                    <div className="storefront-diff-count">
                      <span className="plus">+{file.added}</span> <span className="minus">−{file.removed}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="canvas-secondary-button is-small is-ghost"
                    disabled={!diff || props.busy}
                    aria-expanded={opened === file.path}
                    onClick={() => setOpened(opened === file.path ? null : file.path)}
                  >
                    {t("storefronts.diff")}
                  </button>
                </div>
                {opened === file.path && lines ? (
                  <DiffLines
                    lines={lines.lines}
                    layout="unified"
                    beforeLabel={t("storefronts.before")}
                    afterLabel={t("storefronts.after")}
                    layoutLabel={t("storefronts.diff")}
                  />
                ) : null}
                {file.classification === "conflict" ? (
                  <fieldset className="storefront-conflict" disabled={props.busy}>
                    <legend>{file.path}</legend>
                    <p className="sh-sub">{t("storefronts.conflict")}</p>
                    {(["keep-storefront", "take-workshop"] as const).map((choice) => (
                      <label key={choice}>
                        <input
                          type="radio"
                          name={file.path}
                          value={choice}
                          checked={props.choices[file.path] === choice}
                          onChange={() => props.onChoose(file.path, choice)}
                        />
                        {t(choice === "keep-storefront" ? "storefronts.keep" : "storefronts.take")}
                      </label>
                    ))}
                  </fieldset>
                ) : null}
              </div>
            );
          })}
      </div>
    </section>
  );
}
