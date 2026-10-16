import type { ReactElement } from "react";
import { useI18n } from "../../i18n";

export function PublicationEffects(
  props: Readonly<{
    destination: string;
    repository: string;
    github: boolean;
    pluginId: string;
    workshop: string;
    mode: "new" | "new-existing" | "update" | "publish" | "retry";
    changedFiles: number;
    retryTarget?: string;
  }>,
): ReactElement {
  const { t } = useI18n();
  return (
    <section className="sec">
      <h3>{t("storefronts.effects")}</h3>
      <div className="storefront-rows">
        <div className="storefront-row">
          <div className="rn">
            <b>{props.destination}</b>
            <small>
              {props.mode === "retry"
                ? props.retryTarget
                : t(props.mode === "update" ? "storefronts.updateFiles" : "storefronts.newFiles", {
                    plugin: props.pluginId,
                    count: props.changedFiles,
                  })}
            </small>
          </div>
        </div>
        <div className="storefront-row">
          <div className="rn">
            <b>{t(props.github ? "storefronts.github" : "storefronts.repository")}</b>
            <small>
              {props.repository
                ? t(
                    props.mode === "new"
                      ? "storefronts.createEffect"
                      : props.mode === "new-existing"
                        ? "storefronts.existingEffect"
                        : "storefronts.pushEffect",
                    {
                      repository: props.repository,
                    },
                  )
                : t("canvas.notRead")}
            </small>
          </div>
        </div>
        <div className="storefront-row">
          <div className="rn">
            <b>{props.workshop}</b>
            <small>{t("storefronts.workshopEffect")}</small>
          </div>
        </div>
      </div>
    </section>
  );
}
