import { LoadingSkeleton } from "../components/ui/Skeleton";
import { useId, type ReactElement } from "react";
import { useI18n, tCount } from "../i18n";
import type { PersonalPlugin } from "./personal-marketplace";

export type PluginSelection =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "existing"; packageId: string }>
  | Readonly<{ kind: "new"; name: string; description: string }>;
export function pluginSelectionReady(selection: PluginSelection): boolean {
  return (
    selection.kind === "existing" ||
    (selection.kind === "new" &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(selection.name) &&
      selection.description.trim().length > 0 &&
      selection.description.length <= 1024 &&
      !/[\r\n\u0000-\u001f]/u.test(selection.description))
  );
}
export function PluginPicker(
  props: Readonly<{
    plugins: readonly PersonalPlugin[];
    selection: PluginSelection;
    onChange: (selection: PluginSelection) => void;
    busy?: boolean;
    loading?: boolean;
  }>,
): ReactElement {
  const { t, language } = useI18n();
  const id = useId(),
    selected = props.selection;
  return (
    <>
      <div className="skill-plugin-picker">
        {props.loading && !props.plugins.length ? (
          <LoadingSkeleton label={t("skillActions.marketplaceLoading")} />
        ) : null}
        <label className="skill-plugin-pick">
          <input
            type="radio"
            name={id}
            checked={selected.kind === "new"}
            disabled={props.busy || props.loading}
            onChange={() => props.onChange({ kind: "new", name: "", description: "" })}
          />
          <span>
            <b>{t("skillActions.newPlugin")}</b>
            <small>{t("skillActions.newPluginHint")}</small>
          </span>
        </label>
        {props.plugins.map((plugin) => (
          <label className="skill-plugin-pick" data-testid={`plugin-picker-existing-${plugin.id}`} key={plugin.id}>
            <input
              type="radio"
              name={id}
              checked={selected.kind === "existing" && selected.packageId === plugin.id}
              disabled={props.busy}
              onChange={() => props.onChange({ kind: "existing", packageId: plugin.id })}
            />
            <span>
              <b>{plugin.name}</b>
              <small>
                {tCount("skillActions.skills", plugin.count, {}, language)}
                {plugin.description ? ` — ${plugin.description}` : ""}
              </small>
            </span>
          </label>
        ))}
      </div>
      {selected.kind === "new" ? (
        <div className="skill-new-plugin">
          <input
            className="skill-input"
            aria-label={t("skillActions.pluginName")}
            placeholder={t("skillActions.namePlaceholder")}
            value={selected.name}
            disabled={props.busy}
            onChange={(event) => props.onChange({ ...selected, name: event.target.value })}
            autoComplete="off"
            maxLength={64}
          />
          <input
            className="skill-input"
            aria-label={t("skillActions.pluginDescription")}
            placeholder={t("skillActions.descriptionPlaceholder")}
            value={selected.description}
            disabled={props.busy}
            onChange={(event) => props.onChange({ ...selected, description: event.target.value })}
            maxLength={1024}
          />
          <span className="skill-hint">{t("skillActions.descriptionHint")}</span>
        </div>
      ) : null}
    </>
  );
}
