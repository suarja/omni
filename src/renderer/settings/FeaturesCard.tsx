import type { ReactElement } from "react";

import { FEATURE_KEYS, type FeatureFlags } from "../../shared/settings-ipc";
import { Card, CardHeader } from "../components/ui/Card";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { useI18n, type TranslationKey } from "../i18n";

export type FeaturesCardProps = Readonly<{
  features: FeatureFlags;
  onFeatureChange: (key: keyof FeatureFlags, value: boolean) => void;
}>;

export function FeaturesCard({ features, onFeatureChange }: FeaturesCardProps): ReactElement {
  const { t } = useI18n();
  return (
    <Card className="settings-group" dataTestId="settings-features">
      <CardHeader hint={t("settings.features.description")} title={t("settings.groups.features")} />
      <ItemList>
        {FEATURE_KEYS.map((key) => (
          <ListItem
            className="settings-row"
            key={key}
            name={
              <span className="settings-copy">
                <span className="settings-label">{t(`settings.features.${key}.label` as TranslationKey)}</span>
                <span className="settings-description">{t(`settings.features.${key}.hint` as TranslationKey)}</span>
              </span>
            }
            side={
              <label className="settings-checkbox" data-testid={`settings-feature-${key}`}>
                <input
                  aria-label={t(`settings.features.${key}.label` as TranslationKey)}
                  checked={features[key]}
                  onChange={(event) => onFeatureChange(key, event.target.checked)}
                  type="checkbox"
                />
              </label>
            }
          />
        ))}
      </ItemList>
    </Card>
  );
}
