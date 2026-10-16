import type { ReactElement } from "react";
import type { Harness } from "../../domain/harness-projection";
import type { ObservedPackage } from "../../domain/inventory";
import type { Target } from "./operations-import-plan";
import { packageAssetCount } from "./operations-import-plan";
import { slugify } from "../../domain/marketplace-format";
import { Badge } from "../components/ui/Badge";
import { IconWrap } from "../components/ui/IconWrap";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { tCount, useI18n } from "../i18n";
import { packageBadges, harnessLabel } from "./operations-import-plan";

export function HarnessBadges({
  harnesses,
  t,
}: Readonly<{ harnesses: readonly ("omni" | Harness)[]; t: ReturnType<typeof useI18n>["t"] }>): ReactElement {
  return (
    <span className="import-badges">
      {harnesses.map((harness) => (
        <Badge key={harness} variant="type">
          {harnessLabel(harness, t)}
        </Badge>
      ))}
    </span>
  );
}

export function TargetChoice({
  assetCount,
  language,
  packageInfo,
  selected,
  onSelect,
  t,
}: Readonly<{
  assetCount: number;
  language: "en" | "fr";
  packageInfo: ObservedPackage;
  selected: boolean;
  onSelect: () => void;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  return (
    <ListItem
      ariaPressed={selected}
      dataTestId={`import-target-${packageInfo.id}`}
      leading={<IconWrap name="plugin" size="sm" />}
      name={
        <span className="import-target__copy">
          <strong>{packageInfo.displayName}</strong>
          <span>{tCount("operations.assets", assetCount, {}, language)}</span>
        </span>
      }
      side={<span className="import-target__badges">{packageBadges(packageInfo, t)}</span>}
      selected={selected}
      onClick={onSelect}
    />
  );
}

export function MarketplacePackagePicker({
  packages,
  target,
  targetObservation,
  language,
  onChange,
  t,
}: Readonly<{
  packages: readonly ObservedPackage[];
  target: Target;
  targetObservation: Parameters<typeof packageAssetCount>[0];
  language: "en" | "fr";
  onChange: (target: Target) => void;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  return (
    <ItemList>
      {packages.map((packageInfo) => (
        <TargetChoice
          assetCount={packageAssetCount(targetObservation, packageInfo)}
          key={packageInfo.id}
          language={language}
          onSelect={() => onChange({ kind: "package", packageId: packageInfo.id })}
          packageInfo={packageInfo}
          selected={target.kind === "package" && target.packageId === packageInfo.id}
          t={t}
        />
      ))}
      <ListItem
        ariaPressed={target.kind === "new"}
        dataTestId="import-new-package"
        leading={<IconWrap name="plus" size="sm" />}
        name={
          <span className="import-target__copy">
            <strong>{t("operations.import.newPackage")}</strong>
            <span>{t("operations.import.newPackageHint")}</span>
          </span>
        }
        selected={target.kind === "new"}
        variant="dashed"
        onClick={() => onChange(target.kind === "new" ? target : { kind: "new", name: "" })}
      />
      {target.kind === "new" ? (
        <div className="import-new-package-form">
          <label>
            {t("operations.import.packageName")}
            <input
              aria-label={t("operations.import.packageName")}
              data-testid="import-new-package-name"
              onChange={(event) => onChange({ ...target, name: event.target.value })}
              value={target.name}
            />
            <code>{slugify(target.name) || "—"}</code>
          </label>
          <label>
            {t("skillActions.pluginDescription")}
            <input
              aria-label={t("skillActions.pluginDescription")}
              value={target.description ?? ""}
              onChange={(event) => onChange({ ...target, description: event.target.value })}
            />
          </label>
        </div>
      ) : null}
    </ItemList>
  );
}
