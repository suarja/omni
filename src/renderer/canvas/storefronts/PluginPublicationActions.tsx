import { useState, type ReactElement } from "react";
import type { PersonalPlugin } from "../personal-marketplace";
import { useCanvasRail } from "../rail/rail-context";
import { AnchoredFloating } from "../AnchoredFloating";
import { useI18n } from "../../i18n";
import { pluginIdFor } from "./presentation-model";
import "./storefronts.css";

export function PluginPublicationChips({ plugin }: Readonly<{ plugin: PersonalPlugin }>): ReactElement | null {
  const rail = useCanvasRail(),
    { t } = useI18n();
  if (!rail) return null;
  return (
    <div className="storefront-chips">
      {rail.storefronts.drift?.storefronts.flatMap((storefront) => {
        const publication = storefront.plugins.find((item) => item.pluginId === pluginIdFor(plugin.id));
        return publication ? (
          <span key={storefront.sourceId}>
            <button className="storefront-chip" type="button" onClick={() => rail.openStorefront(storefront.sourceId)}>
              {t("storefronts.publishedIn", { name: storefront.name })}
            </button>
            {publication.status === "ready" && publication.behind ? (
              <span className="project-chip is-update">{t("storefronts.toPublish")}</span>
            ) : null}
          </span>
        ) : (
          []
        );
      })}
    </div>
  );
}
export function PluginPublicationActions(
  props: Readonly<{ plugin: PersonalPlugin; busy: boolean; onDescribe: (anchor: HTMLElement) => void }>,
): ReactElement {
  const rail = useCanvasRail(),
    { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const published =
    rail?.storefronts.drift?.storefronts.filter((storefront) =>
      storefront.plugins.some((plugin) => plugin.pluginId === pluginIdFor(props.plugin.id)),
    ) ?? [];
  function close(): void {
    const opener = anchor;
    setAnchor(null);
    requestAnimationFrame(() => opener?.isConnected && opener.focus());
  }
  return (
    <div className="storefront-plugin-actions">
      {!props.plugin.description ? (
        <button
          className="canvas-secondary-button is-small"
          type="button"
          disabled={props.busy}
          onClick={(event) => props.onDescribe(event.currentTarget)}
        >
          {t("skillActions.describe")}
        </button>
      ) : null}
      <button
        className="storefront-more"
        type="button"
        data-testid={`marketplace-plugin-menu-${props.plugin.id}`}
        aria-label={t("storefronts.more", { name: props.plugin.name })}
        disabled={props.busy}
        aria-haspopup="menu"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        ⋯
      </button>
      {anchor ? (
        <AnchoredFloating
          anchor={anchor}
          kind="menu"
          testId="marketplace-plugin-menu"
          className="storefront-plugin-menu"
          label={t("storefronts.more", { name: props.plugin.name })}
          onClose={close}
        >
          {published.length ? (
            published.map((storefront) => (
              <button
                key={storefront.sourceId}
                role="menuitem"
                type="button"
                onClick={() => {
                  setAnchor(null);
                  rail?.openStorefront(storefront.sourceId);
                }}
              >
                <span>
                  {t("storefronts.viewIn", { name: storefront.name })}
                  <small>{t("storefronts.publicStorefront")}</small>
                </span>
              </button>
            ))
          ) : (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setAnchor(null);
                rail?.openPublish({ pluginId: pluginIdFor(props.plugin.id) });
              }}
            >
              <span>
                {t("storefronts.publishMenu")}
                <small>{t("storefronts.publishMenuHint")}</small>
              </span>
            </button>
          )}
          {!props.plugin.description ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                props.onDescribe(anchor);
                setAnchor(null);
              }}
            >
              {t("skillActions.describe")}
            </button>
          ) : null}
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setAnchor(null);
              rail?.openNewSkill(props.plugin.id);
            }}
          >
            {t("storefronts.newSkill")}
          </button>
        </AnchoredFloating>
      ) : null}
    </div>
  );
}
