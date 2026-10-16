import type { ReactElement } from "react";
import type { ObservedArtifact } from "../../domain/inventory";
import type { Harness } from "../../domain/harness-projection";
import type { OperationPlan } from "../../shared/operations-ipc";
import { artifactName } from "../../domain/identity";
import { Card, CardHeader } from "../components/ui/Card";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { tCount, useI18n } from "../i18n";
import { HarnessBadges } from "./ImportArtifactChoices";
import {
  compactFilePath,
  formatByteSize,
  gitLabel,
  harnessLabel,
  manifestNames,
  preferredArtifactPath,
  writeFileActions,
} from "./operations-import-plan";

export function ImportPreview({
  artifact,
  language,
  marketplaceName,
  packageName,
  plan,
  t,
}: Readonly<{
  artifact: ObservedArtifact;
  language: "en" | "fr";
  marketplaceName: string;
  packageName: string;
  plan: OperationPlan;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement {
  const name = artifactName({ kind: artifact.kind, provenance: { relativePath: preferredArtifactPath(artifact) } });
  const files = writeFileActions(plan);
  const totalSize = files.reduce((total, action) => total + (action.byteLength ?? 0), 0);
  return (
    <Card>
      <CardHeader title={t("operations.import.whatWillBeWritten")} />
      <ItemList variant="nested">
        <ListItem
          name={
            <>
              <strong>{name}</strong> → {packageName}
            </>
          }
          sub={`${tCount("operations.files", files.length, {}, language)} · ${formatByteSize(totalSize)}`}
        />
      </ItemList>
      <div className="import-file-list" data-testid="import-file-list">
        {files.map((action) => (
          <div className="import-file-list__row" key={action.relativePath}>
            <code>{compactFilePath(action.relativePath, plan, artifact, name)}</code>
            <span>{formatByteSize(action.byteLength ?? 0)}</span>
          </div>
        ))}
      </div>
      <ItemList variant="nested">
        <ListItem name={t("operations.import.manifests")} sub={manifestNames(plan)} />
        <ListItem name={t("operations.preview.git")} sub={gitLabel(plan, marketplaceName, t)} />
        <ListItem
          name={
            <span className="import-visible-in">
              <span>{t("operations.preview.visibleIn")}</span>
              <HarnessBadges harnesses={plan.visibleIn ?? []} t={t} />
            </span>
          }
        />
      </ItemList>
    </Card>
  );
}

export function ProjectionChoices({
  available,
  selected,
  onChange,
  t,
}: Readonly<{
  available: readonly Harness[];
  selected: readonly Harness[];
  onChange: (harness: Harness, checked: boolean) => void;
  t: ReturnType<typeof useI18n>["t"];
}>): ReactElement | null {
  if (!available.length) return null;
  return (
    <fieldset className="import-projections">
      <legend>{t("operations.import.projections")}</legend>
      {available.map((harness) => (
        <label key={harness}>
          <input
            checked={selected.includes(harness)}
            onChange={(event) => onChange(harness, event.target.checked)}
            type="checkbox"
          />
          {t("operations.import.alsoVisible", { harness: harnessLabel(harness, t) })}
        </label>
      ))}
    </fieldset>
  );
}
